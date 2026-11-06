/**
 * R1 ORPHANED_PARENT: a user preset whose `inherits` names a preset that does not exist.
 * Studio hides such presets. The fix is to point `inherits` at the preset Bambu now uses for
 * the same filament, printer and nozzle; this module finds and ranks those candidates.
 *
 * Ranking (the spec's plain " 0.4 nozzle" toggle is not enough: on the X2D the unsuffixed
 * name is the 0.6/0.8 nozzle variant, on the X1C it is the 0.4 one):
 *   high    same stem and printer, and its resolved compatible_printers include
 *           "<model> <size> nozzle" for every target size; or, when compatibility is unknown,
 *           the " 0.4 nozzle" toggle of the missing name when that fits the target; or a
 *           capitalization-only difference.
 *   medium  same stem and printer, other or uncertain nozzle.
 *   low     same stem, other printer. Never pre-selected.
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
  certainUnsuffixedNozzles,
  coversAll,
  nozzlesFor,
  ownCompat,
  possibleUnsuffixedNozzles,
  unsuffixedConvention,
} from './r1Nozzles.js';

export const R1_ID = RULE_IDS.orphanedParent;

/** Other-printer candidates are rarely right; keep the list short enough to read. */
const MAX_LOW_CANDIDATES = 10;

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
  const { links, end } = chain(preset, ctx.resolve);
  const base = { ruleId: R1_ID, presetPath: preset.path, presetName: name };

  switch (end.kind) {
    case 'root':
      return null;
    case 'missing':
      if (links.length === 0) return orphanFinding(preset, name, end.name, ctx);
      return {
        ...base,
        severity: 'warning',
        status: 'hidden',
        title: 'Parent preset is hidden',
        explanation:
          `This preset is based on your preset "${end.referencedBy}", which Studio hides because ` +
          `the preset it is based on ("${end.name}") no longer exists. Fixing ` +
          `"${end.referencedBy}" will bring this one back too.`,
      };
    case 'cycle':
      return {
        ...base,
        severity: 'error',
        status: 'broken',
        title: 'Parent presets form a loop',
        explanation:
          `This preset's chain of parent presets loops back on itself at "${end.name}", so ` +
          `Studio can't work out its settings. Recreate it in Bambu Studio from a current preset.`,
      };
    case 'tooDeep':
      return {
        ...base,
        severity: 'error',
        status: 'broken',
        title: 'Too many parent presets',
        explanation:
          'This preset sits at the end of an unusually long chain of parent presets, which ' +
          'usually means the files are damaged. Recreate it in Bambu Studio from a current preset.',
      };
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
    explanation: explain(target, ranked, ctx.system.version),
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
  name: string;
  source: 'system' | 'user';
  parsed: ParsedPresetName;
  preset?: UserPreset;
}

interface Ranked {
  candidate: Candidate;
  /** How a high candidate was found; drives the explanation wording. */
  via: 'compat' | 'name' | 'other';
  sortKey: number;
  /** Its setting_id is the orphan's base_id. */
  fromBaseId: boolean;
}

const CONFIDENCE_ORDER: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

const BASE_ID_NOTE = "Your preset's sync file (.info) also names it.";

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
      c.source === 'system' ? (await ctx.system.load(c.name))?.settingId : undefined;
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
        reason: reason + mine,
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
        const reason = nozzleUnsure(target)
          ? `Bambu's current preset for the ${target.model}, for every nozzle that name could mean (${joinList(target.nozzles, 'and')} mm).`
          : `Bambu's current preset for the ${target.model} with a ${joinList(target.nozzles)} mm nozzle.`;
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

  ranked.sort(
    (a, b) =>
      CONFIDENCE_ORDER[a.candidate.confidence] - CONFIDENCE_ORDER[b.candidate.confidence] ||
      a.sortKey - b.sortKey ||
      (a.candidate.source === b.candidate.source ? 0 : a.candidate.source === 'system' ? -1 : 1) ||
      compareText(a.candidate.name, b.candidate.name),
  );
  const out = [
    ...ranked.filter((r) => r.candidate.confidence !== 'low'),
    ...ranked.filter((r) => r.candidate.confidence === 'low').slice(0, MAX_LOW_CANDIDATES),
  ];
  const pick = preselection(out);
  if (pick) pick.candidate.preselected = true;
  return out;
}

/** The single high candidate, or among several the one the orphan's base_id names. */
function preselection(ranked: Ranked[]): Ranked | undefined {
  const high = ranked.filter((r) => r.candidate.confidence === 'high');
  if (high.length === 1) return high[0];
  const named = high.filter((r) => r.fromBaseId);
  return named.length === 1 ? named[0] : undefined;
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
  for (const name of systemNames) {
    const parsed = ctx.system.parsed(name) ?? { stem: name };
    // Studio only lets presets inherit from instantiable ones; skip building blocks.
    const body = await ctx.system.load(name);
    if (body && !body.instantiation) continue;
    pool.push({ name, source: 'system', parsed });
  }

  const seen = new Set(pool.map((p) => p.name));
  for (const p of ctx.presets) {
    if (p === orphan || !p.json) continue;
    const name = presetName(p);
    if (name === undefined || seen.has(name)) continue;
    const parsed = parsePresetName(name);
    if (!parsed || parsed.stem.toLowerCase() !== stem) continue;
    // A preset that is itself orphaned (or loops) would not bring this one back.
    if (chain(p, ctx.resolve).end.kind !== 'root') continue;
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
  if (c.source === 'system' || !c.preset) return ctx.system.effectiveCompatiblePrinters(c.name);
  const own = ownCompat(c.preset.json);
  if (own) return own;
  // The resolver's system side only knows names, so hand system links to the index.
  for (const link of chain(c.preset, ctx.resolve).links) {
    if (link.kind === 'system') return ctx.system.effectiveCompatiblePrinters(link.name);
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

function explain(target: Target, ranked: Ranked[], version: string | null): string {
  const where = version
    ? `in Bambu Studio's system presets (version ${version})`
    : "in Bambu Studio's system presets";
  const intro = `This preset is based on "${target.missing}", which no longer exists ${where}, so Studio hides it.`;
  const high = ranked.filter((r) => r.candidate.confidence === 'high');
  const quote = (r: Ranked): string =>
    r.candidate.source === 'user'
      ? `your own preset "${r.candidate.name}"`
      : `"${r.candidate.name}"`;

  if (high.length === 1) {
    const best = high[0]!;
    const why =
      best.via !== 'compat'
        ? ', which looks like the same preset under its current name'
        : nozzleUnsure(target)
          ? `, which Bambu now uses for all of the ${joinList(target.nozzles, 'and')} mm nozzles`
          : `, which Bambu now uses for the ${joinList(target.nozzles)} mm nozzle`;
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

function joinList(items: string[], conjunction: 'or' | 'and' = 'or'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`;
}

function eqi(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
