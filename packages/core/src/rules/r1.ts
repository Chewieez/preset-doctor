/**
 * R1 ORPHANED_PARENT: a user preset whose `inherits` names a preset that does not exist, or
 * only a template ("instantiation": "false") that Studio never offers as a parent. Studio hides
 * such presets. The fix is to point `inherits` at the preset Bambu now uses for the same
 * filament, printer and nozzle; this module finds and ranks those candidates.
 *
 * Parents resolve within one preset type (RuleContext holds the presets and index of one type).
 * The chain cases (cycle, too deep, a missing parent behind a user parent) are shared here; a
 * missing system parent of a process or printer preset goes to r1Process.ts or r1Machine.ts.
 * The rest of this comment is the filament ranking.
 *
 * Ranking (the spec's plain " 0.4 nozzle" toggle is not enough: on the X2D the unsuffixed
 * name is the 0.6/0.8 nozzle variant, on the X1C it is the 0.4 one):
 *   high    same stem and printer, and its resolved compatible_printers include
 *           "<model> <size> nozzle" for every target size; or, when compatibility is unknown,
 *           the " 0.4 nozzle" toggle of the missing name when that fits the target; or a
 *           capitalization-only difference.
 *           Another printer's preset counts too when its compatible_printers covers the target
 *           the same way: Bambu has folded a printer's own presets into another printer's
 *           ("Bambu PLA Wood @BBL P1S 0.4 nozzle" into "... @BBL X1C", which lists the P1S 0.4
 *           nozzle; docs/r1-history.md).
 *   medium  same stem and printer, other or uncertain nozzle.
 *   low     same stem, other printer, not covering the target. Never pre-selected.
 * A single high candidate is pre-selected. With several, the one the orphan's `.info` base_id
 * names is pre-selected; with none of them named, nothing is.
 *
 * The target sizes (see describeTarget), strongest evidence first:
 *   name     the missing name's own suffix ("... 0.6 nozzle").
 *   compat   the orphan's own compatible_printers for that printer (all must be covered).
 *   family   neither: if every unsuffixed preset for that printer is 0.4-only, 0.4; otherwise
 *            every size any preset for that printer lists (suffixed or not), plus 0.4. Only a
 *            candidate covering all of them is safe; usually none is, so the user is asked to
 *            pick the nozzle.
 *   default  the profile has no unsuffixed preset for that printer to learn from: 0.4.
 * The `.info` base_id is never enough on its own: in real sidecars it often names another
 * nozzle or printer than the preset's own, existing parent (about a third on the machine this was
 * built on; `node scripts/r1-simulate.ts` prints the count), so it only breaks ties between
 * high candidates and, when the target size is a guess (family/default), puts the preset it
 * names first among medium ones.
 *
 * Names are the ones Studio uses: a system preset's is the "name" in its file (see
 * systemIndex.ts). A user preset is only offered when it is in filament/base/, has a system parent
 * or none, and its file name is its name: Studio loads top-level user presets in one pass, so one
 * can't be another's parent, and names a user preset after its file (PresetCollection::load_presets,
 * src/libslic3r/Preset.cpp:1425-1427, 1455, 1516, 1528-1531, 1598@v02.09.01.70, 56a57d00).
 */
import { getInfoValue, INFO_KEYS } from '../infoFile.js';
import {
  DEFAULT_NOZZLE,
  parsePresetName,
  sameNozzle,
  toggleDefaultNozzleSuffix,
  type ParsedPresetName,
} from '../names.js';
import { chain, presetName } from '../resolve.js';
import {
  RULE_IDS,
  type Candidate,
  type Confidence,
  type Finding,
  type UserPreset,
} from '../types.js';
import type { RuleContext } from './context.js';
import {
  BASE_ID_NOTE,
  eqi,
  joinList,
  missingIntro,
  nameFieldNote,
  orderCandidates,
  preselection,
  quoteCandidate,
  rewordFinding,
  type RankedCandidate,
} from './r1Common.js';
import { machineOrphanFinding } from './r1Machine.js';
import { orcaFallbackFinding, orcaMissingFinding } from './r1Orca.js';
import { processOrphanFinding } from './r1Process.js';
import {
  certainUnsuffixedNozzles,
  coversAll,
  nozzlesFor,
  ownCompat,
  possibleUnsuffixedNozzles,
  unsuffixedConvention,
} from './r1Nozzles.js';

export const R1_ID = RULE_IDS.orphanedParent;

/** Display name of a user preset: its `name`, or the file name when that is missing. */
export function displayName(p: UserPreset): string {
  return presetName(p) ?? p.fileStem;
}

/**
 * User presets that R1 findings offer as a new parent, each mapped to the first orphan that
 * offers it. Renaming one of these would leave that orphan pointing at a name that is gone.
 */
export function userCandidateNames(findings: readonly Finding[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of findings) {
    if (f.proposedFix?.kind !== 'setInherits') continue;
    for (const c of f.proposedFix.candidates) {
      if (c.source === 'user' && !out.has(c.name)) out.set(c.name, f.presetName ?? f.presetPath);
    }
  }
  return out;
}

export async function checkR1(preset: UserPreset, ctx: RuleContext): Promise<Finding | null> {
  if (!preset.json) return null;
  const name = displayName(preset);
  const profile = ctx.profile;
  // The texts below are written for Bambu Studio; other slicers reword them.
  const orphanOf = async (missing: string): Promise<Finding> => {
    // Parents resolve within one type, so the replacement has the orphan's type too.
    const f =
      preset.type === 'process'
        ? await processOrphanFinding(preset, name, missing, ctx)
        : preset.type === 'machine'
          ? await machineOrphanFinding(preset, name, missing, ctx)
          : await orphanFinding(preset, name, missing, ctx);
    return profile ? rewordFinding(f, profile) : f;
  };
  const base = { ruleId: R1_ID, presetPath: preset.path, presetName: name };
  if (ctx.orca) {
    const fallback = await orcaFallbackFinding(base, preset, ctx, orphanOf);
    if (fallback) return fallback;
  }
  const f = await chainFinding(preset, name, ctx, orphanOf);
  if (!f) return null;
  const { end } = chain(preset, ctx.resolve);
  return ctx.orca && end.kind === 'missing' ? orcaMissingFinding(f, end.name, ctx) : f;
}

async function chainFinding(
  preset: UserPreset,
  name: string,
  ctx: RuleContext,
  orphanOf: (missing: string) => Promise<Finding>,
): Promise<Finding | null> {
  const { links, end } = chain(preset, ctx.resolve);
  const base = { ruleId: R1_ID, presetPath: preset.path, presetName: name };
  const reword = (f: Finding): Finding => (ctx.profile ? rewordFinding(f, ctx.profile) : f);

  switch (end.kind) {
    case 'root':
      return null;
    case 'missing':
      if (links.length === 0) return orphanOf(end.name);
      return reword({
        ...base,
        severity: 'warning',
        status: 'hidden',
        title: 'Parent preset is hidden',
        explanation:
          `This preset is based on your preset "${end.referencedBy}", which Studio hides because ` +
          `the preset it is based on ("${end.name}") no longer exists. Fixing ` +
          `"${end.referencedBy}" will bring this one back too.`,
      });
    case 'cycle':
      return reword({
        ...base,
        severity: 'error',
        status: 'broken',
        title: 'Parent presets form a loop',
        explanation:
          `This preset's chain of parent presets loops back on itself at "${end.name}", so ` +
          `Studio can't work out its settings. Recreate it in Bambu Studio from a current preset.`,
      });
    case 'tooDeep':
      return reword({
        ...base,
        severity: 'error',
        status: 'broken',
        title: 'Too many parent presets',
        explanation:
          'This preset sits at the end of an unusually long chain of parent presets, which ' +
          'usually means the files are damaged. Recreate it in Bambu Studio from a current preset.',
      });
  }
}

async function orphanFinding(
  preset: UserPreset,
  name: string,
  missing: string,
  ctx: RuleContext,
): Promise<Finding> {
  const target = await describeTarget(missing, preset, ctx);
  const ranked = await rankCandidates(target, preset, ctx);
  const finding: Finding = {
    ruleId: R1_ID,
    severity: 'error',
    presetPath: preset.path,
    presetName: name,
    status: 'hidden',
    title: 'Parent preset is missing',
    explanation: explain(target, ranked, ctx) + nameFieldNote(missing, ctx.presets),
  };
  if (ranked.length > 0) {
    finding.proposedFix = { kind: 'setInherits', candidates: ranked.map((r) => r.candidate) };
  }
  return finding;
}

/** Where the target nozzle sizes came from; see the module comment. */
type NozzleSource = 'name' | 'compat' | 'family' | 'default';

/** What the missing parent was for: its parsed name, printer model and nozzle(s). */
interface Target {
  missing: string;
  parsed: ParsedPresetName | null;
  model: string | null;
  /** Sizes a candidate must cover to rank high; never empty. */
  nozzles: string[];
  source: NozzleSource;
  /**
   * Nozzles the orphan itself lists for the model in its compatible_printers ([] when it lists
   * none). A candidate that doesn't cover these is never ranked high.
   */
  listed: string[];
  /** base_id from the orphan's `.info` sidecar: the setting_id it was made from, per Studio. */
  baseId?: string;
}

async function describeTarget(
  missing: string,
  orphan: UserPreset,
  ctx: RuleContext,
): Promise<Target> {
  const parsed = parsePresetName(missing);
  const model = parsed ? await ctx.system.modelOf(parsed) : null;
  // The real "... 06" presets list only the 0.6 nozzle, even when the missing name has no suffix.
  const listed = model === null ? [] : nozzlesFor(ownCompat(orphan.json) ?? [], model);
  const target: Target = { missing, parsed, model, listed, nozzles: [], source: 'default' };
  const baseId = orphan.info ? getInfoValue(orphan.info, INFO_KEYS.baseId)?.trim() : undefined;
  if (baseId) target.baseId = baseId;

  if (parsed?.nozzle !== undefined) {
    target.nozzles = [parsed.nozzle];
    target.source = 'name';
  } else if (listed.length > 0) {
    target.nozzles = listed;
    target.source = 'compat';
  } else {
    const possible =
      parsed && model !== null
        ? possibleUnsuffixedNozzles(await unsuffixedConvention(parsed, model, ctx.system))
        : null;
    target.nozzles = possible ?? [DEFAULT_NOZZLE];
    target.source = possible ? 'family' : 'default';
  }
  return target;
}

/** True when the missing name leaves the nozzle open and the profile says it varies. */
function nozzleUnsure(target: Target): boolean {
  return target.source === 'family' && target.nozzles.length > 1;
}

/** True when a candidate for `nozzles` covers every target nozzle and fits the orphan's list. */
function fitsTarget(nozzles: readonly string[], target: Target): boolean {
  const has = (t: string): boolean => nozzles.some((n) => sameNozzle(n, t));
  return (
    coversAll(nozzles, target.nozzles) && (target.listed.length === 0 || target.listed.some(has))
  );
}

/** Sizes a candidate surely covers when its compatibility is unknown: suffix or convention. */
async function nameNozzles(c: Pooled, target: Target, ctx: RuleContext): Promise<string[]> {
  if (c.parsed.nozzle !== undefined) return [c.parsed.nozzle];
  if (target.model === null) return [DEFAULT_NOZZLE];
  return certainUnsuffixedNozzles(await unsuffixedConvention(c.parsed, target.model, ctx.system));
}

interface Pooled {
  /** The name Studio knows it by, i.e. what goes into `inherits`. */
  name: string;
  /** System presets: the index name, which SystemIndex methods take. */
  key?: string;
  source: 'system' | 'user';
  parsed: ParsedPresetName;
  preset?: UserPreset;
}

interface Ranked extends RankedCandidate {
  /**
   * How a high candidate was found; drives the explanation wording. 'otherPrinter': by
   * compatible_printers, on a preset named for another printer.
   */
  via: 'compat' | 'otherPrinter' | 'name' | 'other';
}

async function rankCandidates(
  target: Target,
  orphan: UserPreset,
  ctx: RuleContext,
): Promise<Ranked[]> {
  const pool = await candidatePool(target, orphan, ctx);
  const toggled = toggleDefaultNozzleSuffix(target.missing);
  const ranked: Ranked[] = [];

  for (const c of pool) {
    const mine = c.source === 'user' ? ' (one of your own presets)' : '';
    // base_id in a sidecar refers to system presets; leave it alone for user parents.
    const settingId =
      c.source === 'system' ? (await ctx.system.load(c.key ?? c.name))?.settingId : undefined;
    const fromBaseId = target.baseId !== undefined && settingId === target.baseId;
    const push = (
      confidence: Confidence,
      reason: string,
      via: Ranked['via'],
      sortKey = 0,
    ): void => {
      const candidate: Candidate = {
        name: c.name,
        confidence,
        // coverReason already says whose preset it is.
        reason: via === 'compat' || via === 'otherPrinter' ? reason : reason + mine,
        preselected: false,
        source: c.source,
      };
      if (settingId !== undefined) candidate.settingId = settingId;
      ranked.push({ candidate, via, sortKey, fromBaseId });
    };

    if (c.name.toLowerCase() === target.missing.toLowerCase()) {
      push('high', 'Same name, only the capitalization differs.', 'name');
      continue;
    }
    if (!target.parsed || !(await samePrinter(target, c.parsed, ctx))) {
      // Another printer's preset that lists the target printer and nozzle is as good as one
      // with the target's printer code: Bambu folds printers' presets together.
      const compat = target.parsed && target.model !== null ? await effectiveCompat(c, ctx) : null;
      if (target.model !== null && compat && compat.length > 0) {
        if (fitsTarget(nozzlesFor(compat, target.model), target)) {
          const reason = `${coverReason(target, c.source)} Its name is for the ${printerLabel(c.parsed)}, but it lists yours.`;
          push('high', fromBaseId ? `${reason} ${BASE_ID_NOTE}` : reason, 'otherPrinter');
          continue;
        }
      }
      const own = c.parsed.nozzle ?? DEFAULT_NOZZLE;
      const nozzleMatch = target.nozzles.some((t) => sameNozzle(own, t)) ? 0 : 1;
      push(
        'low',
        `Same filament, but for a different printer (${printerLabel(c.parsed)}).`,
        'other',
        nozzleMatch,
      );
      continue;
    }

    const compat = await effectiveCompat(c, ctx);
    const known = compat && compat.length > 0 ? compat : null;
    if (target.model !== null && known) {
      const nozzles = nozzlesFor(known, target.model);
      if (fitsTarget(nozzles, target)) {
        const reason = coverReason(target, c.source);
        push('high', fromBaseId ? `${reason} ${BASE_ID_NOTE}` : reason, 'compat');
      } else if (
        nozzles.length > 0 &&
        (nozzleUnsure(target) || (fromBaseId && !hardEvidence(target)))
      ) {
        // Nothing firm says which nozzle the parent was for: list the sizes neutrally, smallest
        // first, with the preset the sidecar names on top.
        push(
          'medium',
          fromBaseId
            ? `Your preset's sync file (.info) says it was made from this preset, which is for the ${joinList(nozzles)} mm nozzle. That file is not always right, so check it matches your nozzle.`
            : `Same filament and printer, for the ${joinList(nozzles)} mm nozzle.`,
          'other',
          fromBaseId ? -1 : Math.min(...nozzles.map(Number)),
        );
      } else if (nozzles.length > 0) {
        const overlap = nozzles.some((n) => target.nozzles.some((t) => sameNozzle(n, t)));
        push(
          'medium',
          `Same filament and printer, but ${overlap ? 'only ' : ''}for the ${joinList(nozzles)} mm nozzle.`,
          'other',
          overlap ? 0 : nozzleDistance(nozzles, target.nozzles),
        );
      } else {
        push(
          'medium',
          `Same filament and printer name, but it does not list the ${target.model}.`,
          'other',
          99,
        );
      }
    } else if (c.name === toggled && fitsTarget(await nameNozzles(c, target, ctx), target)) {
      const verb = target.missing.endsWith(` ${DEFAULT_NOZZLE} nozzle`) ? 'removed' : 'added';
      push('high', `Same name with " ${DEFAULT_NOZZLE} nozzle" ${verb}.`, 'name');
    } else {
      push(
        'medium',
        "Same filament and printer; Preset Doctor couldn't tell which nozzle it is for.",
        'other',
        nozzleDistance([c.parsed.nozzle ?? DEFAULT_NOZZLE], target.nozzles),
      );
    }
  }

  const out = orderCandidates(ranked);
  const pick = preselection(out);
  if (pick) pick.candidate.preselected = true;
  return out;
}

/** Why a candidate whose compatible_printers covers the target is a good match. */
function coverReason(target: Target, source: Candidate['source']): string {
  const whose = source === 'user' ? 'Your own preset' : "Bambu's current preset";
  return nozzleUnsure(target)
    ? `${whose} for the ${target.model}, for every nozzle that name could mean (${joinList(target.nozzles, 'and')} mm).`
    : `${whose} for the ${target.model} with a ${joinList(target.nozzles)} mm nozzle.`;
}

/** The target sizes come from the name or the orphan's own list, not from a guess. */
function hardEvidence(target: Target): boolean {
  return target.source === 'name' || target.source === 'compat';
}

/** System and user presets with the same filament stem (case-insensitive). */
async function candidatePool(
  target: Target,
  orphan: UserPreset,
  ctx: RuleContext,
): Promise<Pooled[]> {
  const stem = (target.parsed?.stem ?? target.missing).toLowerCase();
  const pool: Pooled[] = [];

  const systemNames = target.parsed
    ? ctx.system.namesWithStem(target.parsed.stem)
    : ctx.system.names().filter((n) => n.toLowerCase() === stem);
  const seen = new Set<string>();
  for (const key of systemNames) {
    // Studio only lets presets inherit from instantiable ones; skip building blocks.
    const body = await ctx.system.load(key);
    if (body && !body.instantiation) continue;
    const name = body?.studioName ?? key;
    // Two files with the same name: Studio refuses to load the whole vendor profile
    // ("duplicated defines", src/libslic3r/PresetBundle.cpp:6539-6544, 6921-6927@v02.09.01.70).
    // Keep the first one, defensively.
    if (seen.has(name)) continue;
    seen.add(name);
    const parsed =
      name === key
        ? (ctx.system.parsed(key) ?? { stem: key })
        : (parsePresetName(name) ?? { stem: name });
    pool.push({ name, key, source: 'system', parsed });
  }

  // Studio only finds a parent for a filament/base/ preset among system presets.
  if (orphan.isBase) return pool;
  for (const p of ctx.presets) {
    if (p === orphan || !p.json || !p.isBase) continue;
    const name = presetName(p);
    if (name === undefined || name !== p.fileStem || seen.has(name)) continue;
    const parsed = parsePresetName(name);
    if (!parsed || parsed.stem.toLowerCase() !== stem) continue;
    // A preset that is itself orphaned (or loops, or has a user parent) would not bring this one back.
    const up = chain(p, ctx.resolve);
    if (up.end.kind !== 'root' || up.links.some((l) => l.kind === 'user')) continue;
    seen.add(name);
    pool.push({ name, source: 'user', parsed, preset: p });
  }
  return pool;
}

async function samePrinter(
  target: Target,
  other: ParsedPresetName,
  ctx: RuleContext,
): Promise<boolean> {
  const a = target.parsed;
  if (!a) return false;
  if (a.printerCode === undefined || other.printerCode === undefined) {
    return a.printerCode === undefined && other.printerCode === undefined;
  }
  if (a.model === undefined && other.model === undefined) {
    return eqi(a.vendorTag, other.vendorTag) && eqi(a.printerCode, other.printerCode);
  }
  // A wizard name ("@Bambu Lab X2D") against a code ("@BBL X2D"): compare full models.
  const otherModel = await ctx.system.modelOf(other);
  return target.model !== null && otherModel !== null && target.model === otherModel;
}

/** compatible_printers as Studio resolves it, through user and system parents. */
async function effectiveCompat(c: Pooled, ctx: RuleContext): Promise<readonly string[] | null> {
  if (c.source === 'system' || !c.preset) {
    return ctx.system.effectiveCompatiblePrinters(c.key ?? c.name);
  }
  const own = ownCompat(c.preset.json);
  if (own) return own;
  // The resolver's system side only knows names, so hand system links to the index.
  for (const link of chain(c.preset, ctx.resolve).links) {
    if (link.kind === 'system') return ctx.system.effectiveCompatiblePrinters(link.entry.name);
    const v = ownCompat(link.preset.json);
    if (v) return v;
  }
  return null;
}

/** Distance from the closest candidate nozzle to the closest target nozzle, in mm. */
function nozzleDistance(nozzles: string[], targets: string[]): number {
  return Math.min(...nozzles.flatMap((n) => targets.map((t) => Math.abs(Number(n) - Number(t)))));
}

function printerLabel(p: ParsedPresetName): string {
  if (p.model !== undefined) return p.model;
  if (p.printerCode !== undefined) return p.printerCode;
  return p.nozzle !== undefined ? `any printer, ${p.nozzle} mm nozzle` : 'any printer';
}

function explain(target: Target, ranked: Ranked[], ctx: RuleContext): string {
  const intro = missingIntro(target.missing, ctx.system);
  const high = ranked.filter((r) => r.candidate.confidence === 'high');
  const quote = (r: Ranked): string => quoteCandidate(r.candidate);

  if (high.length === 1) {
    const best = high[0]!;
    const nozzles = nozzleUnsure(target)
      ? `all of the ${joinList(target.nozzles, 'and')} mm nozzles`
      : `the ${joinList(target.nozzles)} mm nozzle`;
    // "Bambu now uses" fits only Bambu's own presets; a user preset is just "for" them.
    const uses = best.candidate.source === 'user' ? 'is for' : 'Bambu now uses for';
    const why =
      best.via === 'otherPrinter'
        ? `, which ${uses} the ${target.model ?? 'printer'} with ${nozzles}, although its name is for another printer`
        : best.via !== 'compat'
          ? ', which looks like the same preset under its current name'
          : `, which ${uses} ${nozzles}`;
    return `${intro} The closest match is ${quote(best)}${why}.`;
  }
  if (high.length > 1) {
    const named = preselection(ranked);
    if (named) {
      return `${intro} ${high.length} presets look like good replacements; ${quote(named)} is pre-selected because your preset's sync file (.info) names it.`;
    }
    return `${intro} ${high.length} presets look like good replacements; pick the one that matches your printer and nozzle.`;
  }
  if (nozzleUnsure(target) && ranked.some((r) => r.candidate.confidence === 'medium')) {
    return (
      `${intro} Its name doesn't include a nozzle size, and on the ${target.model ?? 'printer'}, ` +
      `a name like that doesn't say which nozzle it was for (it could be the ` +
      `${joinList(target.nozzles)} mm nozzle), so Preset Doctor can't tell. Pick the preset ` +
      `for the nozzle you print with.`
    );
  }
  if (ranked.length > 0) {
    return `${intro} There is no exact replacement. The closest options are listed below; only pick one if it matches your printer and nozzle.`;
  }
  return `${intro} Preset Doctor found no similar preset to switch to. You can recreate it in Bambu Studio from a current preset and copy your settings over.`;
}
