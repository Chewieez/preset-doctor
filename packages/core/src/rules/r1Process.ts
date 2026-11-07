/**
 * R1 for process presets: the parent a user process names is gone, so Studio skips the preset
 * ("can not find parent", src/libslic3r/Preset.cpp:1528-1531@v02.09.01.70), exactly as for a
 * filament. Studio offers a process only for the printers its compatible_printers lists, and a
 * user process gets that list from its parent (none of the live ones sets its own), so the new
 * parent decides which printers the process is for. Candidates are matched by that list, never by
 * abbreviating the printer code: "@BBL X1C" processes also list the X1, P1S and X1E.
 *
 * Process names are "<layer>mm <profile> @<tag>[ <d> nozzle]" (parseProcessName). BBL names never
 * spell out the 0.4 nozzle, so a name without a size is for 0.4.
 *
 * The target (what the missing parent covered), strongest evidence first:
 *   own     the orphan's own compatible_printers, when it sets a non-empty one.
 *   tag     the printers that today's processes with the same tag and nozzle list (for that
 *           nozzle), together.
 *   baseId  the printers of the process whose setting_id is the orphan's .info base_id. For
 *           processes base_id matched the parent in 13 of 13 live sidecars, but it is cloud
 *           metadata, so on its own it never makes a candidate high.
 * Ranking (first rule that fits):
 *   high    same name apart from capitalization or spacing; or the same name with the nozzle size
 *           written out or left out; or the same layer height and profile and its printers cover
 *           the target (tag or own).
 *   medium  same layer height and printers (or, target unknown, the same tag and nozzle), other
 *           profile: Bambu's real renames (Optimal to Standard, Fine to High Quality). Same layer,
 *           profile and nozzle for some of the target printers. Raised from low or none, and
 *           listed first: the process the .info base_id names.
 *   low     same layer height and profile for other printers (printer renames such as N1 to A1M);
 *           same tag and nozzle, other layer height (closest first).
 * Pre-selection is the filament rule: a single high candidate, or the one base_id names.
 */
import { getInfoValue, INFO_KEYS } from '../infoFile.js';
import {
  DEFAULT_NOZZLE,
  looseName,
  parseCompatiblePrinter,
  parseProcessName,
  sameNozzle,
  type ParsedProcessName,
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
  eqi,
  joinList,
  missingParent,
  nameFieldNote,
  orderCandidates,
  preselectedByInfoText,
  preselection,
  quoteCandidate,
  shortList,
  type RankedCandidate,
} from './r1Common.js';
import { ownCompat } from './r1Nozzles.js';

interface Target {
  missing: string;
  parsed: ParsedProcessName | null;
  /** Nozzle the missing parent was for: its suffix, else what its printers share, else 0.4. */
  nozzle: string;
  /** compatible_printers entries a candidate must list to rank high; null when unknown. */
  printers: string[] | null;
  source: 'own' | 'tag' | 'baseId' | 'unknown';
  baseId?: string;
}

interface Pooled {
  name: string;
  /** System presets: the index name, which SystemIndex methods take. */
  key?: string;
  source: 'system' | 'user';
  parsed: ParsedProcessName;
  settingId?: string;
  /** Effective compatible_printers; null when unknown or empty ("every printer"). */
  printers: string[] | null;
}

interface Ranked extends RankedCandidate {
  via: 'name' | 'covers' | 'other';
}

export async function processOrphanFinding(
  preset: UserPreset,
  name: string,
  missing: string,
  ctx: RuleContext,
): Promise<Finding> {
  const pool = await processPool(preset, ctx);
  const target = await describeTarget(missing, preset, pool);
  const ranked = rank(target, pool);
  const why = await missingParent(missing, ctx.system);
  const finding: Finding = {
    ruleId: RULE_IDS.orphanedParent,
    severity: 'error',
    presetPath: preset.path,
    presetName: name,
    status: 'hidden',
    title: why.title,
    explanation: explain(target, ranked, why.intro) + nameFieldNote(missing, ctx.presets),
  };
  if (ranked.length > 0) {
    finding.proposedFix = { kind: 'setInherits', candidates: ranked.map((r) => r.candidate) };
  }
  return finding;
}

/**
 * Instantiable system processes whose name parses (so fdm_process_* templates are left out), and
 * the user's process/base/ presets that Studio could use as a parent (see r1.ts).
 */
async function processPool(orphan: UserPreset, ctx: RuleContext): Promise<Pooled[]> {
  const pool: Pooled[] = [];
  const seen = new Set<string>();
  for (const body of await ctx.system.loadAll()) {
    if (!body.instantiation) continue;
    const name = body.studioName;
    const parsed = parseProcessName(name);
    if (!parsed || seen.has(name)) continue;
    seen.add(name);
    const printers = await ctx.system.effectiveCompatiblePrinters(body.name);
    const p: Pooled = {
      name,
      key: body.name,
      source: 'system',
      parsed,
      printers: printers && printers.length > 0 ? printers : null,
    };
    if (body.settingId !== undefined) p.settingId = body.settingId;
    pool.push(p);
  }
  // Studio only finds a parent for a base/ preset among system presets.
  if (orphan.isBase) return pool;
  for (const u of ctx.presets) {
    if (u === orphan || !u.json || !u.isBase) continue;
    const name = presetName(u);
    if (name === undefined || name !== u.fileStem || seen.has(name)) continue;
    const parsed = parseProcessName(name);
    if (!parsed) continue;
    const up = chain(u, ctx.resolve);
    if (up.end.kind !== 'root' || up.links.some((l) => l.kind === 'user')) continue;
    seen.add(name);
    let printers = ownCompat(u.json) ?? null;
    const sys = up.links[0];
    if (printers === null && sys?.kind === 'system') {
      printers = await ctx.system.effectiveCompatiblePrinters(sys.entry.name);
    }
    pool.push({
      name,
      source: 'user',
      parsed,
      printers: printers && printers.length > 0 ? [...printers] : null,
    });
  }
  return pool;
}

async function describeTarget(
  missing: string,
  orphan: UserPreset,
  pool: readonly Pooled[],
): Promise<Target> {
  const parsed = parseProcessName(missing);
  const target: Target = {
    missing,
    parsed,
    nozzle: parsed?.nozzle ?? DEFAULT_NOZZLE,
    printers: null,
    source: 'unknown',
  };
  const baseId = orphan.info ? getInfoValue(orphan.info, INFO_KEYS.baseId)?.trim() : undefined;
  if (baseId) target.baseId = baseId;

  const own = ownCompat(orphan.json);
  if (own && own.length > 0) {
    target.printers = [...own];
    target.source = 'own';
  } else if (parsed) {
    const union: string[] = [];
    for (const c of pool) {
      if (c.source !== 'system' || !eqi(c.parsed.tag, parsed.tag)) continue;
      if (!sameNozzle(c.parsed.nozzle ?? DEFAULT_NOZZLE, target.nozzle)) continue;
      for (const entry of c.printers ?? []) {
        const cp = parseCompatiblePrinter(entry);
        if (
          cp &&
          sameNozzle(cp.nozzle, target.nozzle) &&
          !union.some((u) => samePrinter(u, entry))
        ) {
          union.push(entry);
        }
      }
    }
    if (union.length > 0) {
      target.printers = union;
      target.source = 'tag';
    }
  }
  if (target.printers === null && baseId) {
    const named = pool.find((c) => c.source === 'system' && c.settingId === baseId);
    if (named?.printers) {
      target.printers = named.printers;
      target.source = 'baseId';
    }
  }
  if (parsed?.nozzle === undefined && target.printers) {
    const sizes = target.printers.map((e) => parseCompatiblePrinter(e)?.nozzle);
    const first = sizes[0];
    if (first !== undefined && sizes.every((s) => s !== undefined && sameNozzle(s, first))) {
      target.nozzle = first;
    }
  }
  return target;
}

function rank(target: Target, pool: readonly Pooled[]): Ranked[] {
  const ranked: Ranked[] = [];
  const t = target.parsed;
  const known = target.printers;
  const strong = known !== null && target.source !== 'baseId';

  for (const c of pool) {
    const fromBaseId = target.baseId !== undefined && c.settingId === target.baseId;
    const push = (
      confidence: Confidence,
      reason: string,
      via: Ranked['via'],
      sortKey = 0,
    ): void => {
      const mine = c.source === 'user' ? ' (one of your own presets)' : '';
      const candidate: Candidate = {
        name: c.name,
        confidence,
        reason: reason + mine,
        preselected: false,
        source: c.source,
      };
      if (c.settingId !== undefined) candidate.settingId = c.settingId;
      if (c.printers) candidate.printers = c.printers;
      ranked.push({ candidate, sortKey, fromBaseId, via });
    };
    const raised = (): void =>
      push(
        'medium',
        "Your preset's sync file (.info) says it was made from this preset.",
        'other',
        -1,
      );

    if (looseName(c.name) === looseName(target.missing)) {
      push('high', 'Same name, only capitalization or spacing differs.', 'name');
      continue;
    }
    if (!t) {
      if (fromBaseId) raised();
      continue;
    }
    const p = c.parsed;
    const sameLayer = Number(p.layer) === Number(t.layer);
    const sameProfile = eqi(p.profile, t.profile);
    const sameTag = eqi(p.tag, t.tag);
    const nozzleMatch = sameNozzle(p.nozzle ?? DEFAULT_NOZZLE, target.nozzle);
    const covers = known !== null && c.printers !== null && known.every((k) => listed(c, k));
    const shared = known && c.printers ? known.filter((k) => listed(c, k)) : [];

    if (sameLayer && sameProfile && sameTag && nozzleMatch) {
      push('high', 'Same name, with the nozzle size written out or left out.', 'name');
    } else if (sameLayer && sameProfile && covers && strong) {
      const whose = c.source === 'user' ? 'Your own process' : "Bambu's current process";
      const reason = `${whose} for ${shortList(known ?? [])}, ${p.layer} mm ${p.profile}.`;
      push(
        'high',
        sameTag ? reason : `${reason} Its name is for ${p.tag}, but it lists your printers.`,
        'covers',
      );
    } else if (fromBaseId) {
      raised();
    } else if (
      sameLayer &&
      !sameProfile &&
      (covers || (known === null && sameTag && nozzleMatch))
    ) {
      push(
        'medium',
        `Same layer height and printer, but the ${p.profile} profile, not ${t.profile}.`,
        'other',
      );
    } else if (sameLayer && sameProfile && covers) {
      push(
        'medium',
        'Same layer height and profile, for the printers of the preset your sync file (.info) names.',
        'other',
      );
    } else if (sameLayer && sameProfile && nozzleMatch && shared.length > 0) {
      push(
        'medium',
        `Same profile, for some of the same printers (${shortList(shared)}).`,
        'other',
        1,
      );
    } else if (sameLayer && sameProfile) {
      push('low', `Same profile, but for ${shortList(c.printers ?? [p.tag])}.`, 'other');
    } else if (sameTag && nozzleMatch) {
      push(
        'low',
        `Same printer, ${p.layer} mm layers instead of ${t.layer}.`,
        'other',
        1 + Math.abs(Number(p.layer) - Number(t.layer)),
      );
    }
  }

  const out = orderCandidates(ranked, Infinity);
  const pick = preselection(out);
  if (pick) pick.candidate.preselected = true;
  return out;
}

/** True when c's printers list `entry` (model compared case-insensitively, nozzle by value). */
function listed(c: Pooled, entry: string): boolean {
  return (c.printers ?? []).some((e) => samePrinter(e, entry));
}

function samePrinter(a: string, b: string): boolean {
  const pa = parseCompatiblePrinter(a);
  const pb = parseCompatiblePrinter(b);
  if (!pa || !pb) return a.toLowerCase() === b.toLowerCase();
  return pa.model.toLowerCase() === pb.model.toLowerCase() && sameNozzle(pa.nozzle, pb.nozzle);
}

const PRINTERS_NOTE = 'The new parent decides which printers Studio offers this process for';

function explain(target: Target, ranked: Ranked[], intro: string): string {
  const high = ranked.filter((r) => r.candidate.confidence === 'high');
  const pick = ranked.find((r) => r.candidate.preselected);
  const printers = pick?.candidate.printers;
  const note = printers ? ` ${PRINTERS_NOTE}: ${shortList(printers)}.` : ` ${PRINTERS_NOTE}.`;

  if (high.length === 1) {
    const best = high[0]!;
    const why =
      best.via === 'covers'
        ? `, which ${best.candidate.source === 'user' ? 'is for' : 'Bambu now uses for'} ${shortList(target.printers ?? [])}`
        : ', which looks like the same preset under its current name';
    return `${intro} The closest match is ${quoteCandidate(best.candidate)}${why}.${note}`;
  }
  if (high.length > 1) {
    const named = preselection(ranked);
    if (named) {
      return `${intro} ${high.length} presets look like good replacements; ${preselectedByInfoText(named.candidate)}.${note}`;
    }
    return `${intro} ${high.length} presets look like good replacements; pick the one for your printer and nozzle.${note}`;
  }
  if (ranked.length > 0) {
    const forWhat = target.printers ? ` It was for ${shortList(target.printers)}.` : '';
    return `${intro}${forWhat} There is no exact replacement. The closest options are listed below; only pick one that is for your printer and nozzle.${note}`;
  }
  return `${intro} Preset Doctor found no similar preset to switch to. You can recreate it in Bambu Studio from a current preset and copy your settings over.`;
}

/** Printer list wording for the fix description (see planFixes). */
export function processPrintersNote(printers: readonly string[]): string {
  return `${PRINTERS_NOTE}: ${joinList([...printers], 'and')}.`;
}
