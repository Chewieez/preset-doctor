/**
 * Pieces of R1 that every preset type shares: the opening sentence, the candidate order and the
 * pre-selection rule. The type-specific ranking is in r1.ts (filament), r1Process.ts and
 * r1Machine.ts.
 */
import { presetName } from '../resolve.js';
import { compareText, type SlicerProfile } from '../slicer.js';
import type { SystemIndex } from '../systemIndex.js';
import type { Candidate, Confidence, Finding, UserPreset } from '../types.js';

/**
 * The finding with its texts reworded for the slicer (SlicerProfile.reword): title, explanation
 * and candidate reasons. For Bambu Studio, the finding itself.
 */
export function rewordFinding(f: Finding, profile: SlicerProfile): Finding {
  if (profile.id === 'bambu') return f;
  const out: Finding = {
    ...f,
    title: profile.reword(f.title),
    explanation: profile.reword(f.explanation),
  };
  if (f.proposedFix?.kind === 'setInherits') {
    out.proposedFix = {
      kind: 'setInherits',
      candidates: f.proposedFix.candidates.map((c) => ({ ...c, reason: profile.reword(c.reason) })),
    };
  }
  return out;
}

/** Other-printer filament candidates are rarely right; keep the list short enough to read. */
export const MAX_LOW_CANDIDATES = 10;

export const CONFIDENCE_ORDER: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

export const BASE_ID_NOTE = "Your preset's sync file (.info) also names it.";

/** A candidate while it is being ranked. */
export interface RankedCandidate {
  candidate: Candidate;
  /** Orders candidates of the same confidence: lower first. */
  sortKey: number;
  /** Its setting_id is the orphan's base_id. */
  fromBaseId: boolean;
}

/**
 * Sorts by confidence, then sortKey, then system before user, then name; keeps every high and
 * medium candidate and at most `maxLow` low ones. Printer and process lists pass Infinity: the
 * user must pick from them, there are only about 14 printers per nozzle and 11 tags per profile,
 * and an alphabetical cut can drop the right one (a printer renamed from a code such as X1C).
 */
export function orderCandidates<T extends RankedCandidate>(
  ranked: T[],
  maxLow = MAX_LOW_CANDIDATES,
): T[] {
  ranked.sort(
    (a, b) =>
      CONFIDENCE_ORDER[a.candidate.confidence] - CONFIDENCE_ORDER[b.candidate.confidence] ||
      a.sortKey - b.sortKey ||
      (a.candidate.source === b.candidate.source ? 0 : a.candidate.source === 'system' ? -1 : 1) ||
      compareText(a.candidate.name, b.candidate.name),
  );
  return [
    ...ranked.filter((r) => r.candidate.confidence !== 'low'),
    ...ranked.filter((r) => r.candidate.confidence === 'low').slice(0, maxLow),
  ];
}

/** The single high candidate, or among several the one the orphan's base_id names. */
export function preselection<T extends RankedCandidate>(ranked: readonly T[]): T | undefined {
  const high = ranked.filter((r) => r.candidate.confidence === 'high');
  if (high.length === 1) return high[0];
  const named = high.filter((r) => r.fromBaseId);
  return named.length === 1 ? named[0] : undefined;
}

export const MISSING_PARENT_TITLE = 'Parent preset is missing';
export const TEMPLATE_PARENT_TITLE = 'Parent is a template, not a preset';

/** The title and the opening sentence of a direct orphan's finding. */
export interface MissingParent {
  /** Studio finds the parent, but its file says it is not instantiable (a template). */
  template: boolean;
  title: string;
  intro: string;
}

/**
 * Why `missing` is no parent. A parent that Studio's name lookup finds but whose body is not
 * instantiable (a template such as fdm_process_common) exists, but Studio can't use it as a
 * parent (see studioNameLookup). Every other missing name no longer exists as far as Studio is
 * concerned, including an index name whose file carries another name (systemIndex.ts).
 */
export async function missingParent(missing: string, system: SystemIndex): Promise<MissingParent> {
  const where = system.version
    ? `in Bambu Studio's system presets (version ${system.version})`
    : "in Bambu Studio's system presets";
  const entry = await system.findByStudioName(missing);
  const body = entry ? await system.load(entry.name) : null;
  if (body !== null && !body.instantiation) {
    return {
      template: true,
      title: TEMPLATE_PARENT_TITLE,
      intro:
        `This preset is based on "${missing}", which is an internal template ${where} that ` +
        "presets can't be based on, so Studio hides it.",
    };
  }
  return {
    template: false,
    title: MISSING_PARENT_TITLE,
    intro: `This preset is based on "${missing}", which no longer exists ${where}, so Studio hides it.`,
  };
}

/** The base_id tie-break among several high candidates (see preselection), as explained. */
export function preselectedByInfoText(c: Candidate): string {
  return `${quoteCandidate(c)} is pre-selected because your preset's sync file (.info) names it`;
}

/** preselectedByInfoText for a candidate that ends up not pre-selected (r1Orca.ts). */
export function namedByInfoText(c: Candidate): string {
  return `${quoteCandidate(c)} is the one your preset's sync file (.info) names`;
}

/**
 * When the missing name is the `name` inside one of the user's own files, say why that doesn't
 * count: Studio knows a user preset only by its file name (see resolve.ts).
 */
export function nameFieldNote(missing: string, presets: readonly UserPreset[]): string {
  const p = presets.find((x) => x.fileStem !== missing && presetName(x) === missing);
  if (!p) return '';
  return (
    ` Your preset file "${p.fileStem}.json" has "${missing}" as its name inside, but Studio ` +
    `knows a preset of yours only by its file name, "${p.fileStem}".`
  );
}

/** "your own preset "X"" for user candidates, else just the quoted name. */
export function quoteCandidate(c: Candidate): string {
  return c.source === 'user' ? `your own preset "${c.name}"` : `"${c.name}"`;
}

export function joinList(items: readonly string[], conjunction: 'or' | 'and' = 'or'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`;
}

/** Up to `max` items, then "and N more". */
export function shortList(items: readonly string[], max = 3): string {
  if (items.length <= max) return joinList(items, 'and');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

export { compareText } from '../slicer.js';

export function eqi(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
}
