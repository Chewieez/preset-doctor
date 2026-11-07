/**
 * Pieces of R1 that every preset type shares: the opening sentence, the candidate order and the
 * pre-selection rule. The type-specific ranking is in r1.ts (filament), r1Process.ts and
 * r1Machine.ts.
 */
import { presetName } from '../resolve.js';
import type { SlicerProfile } from '../slicer.js';
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

/** Other-printer candidates are rarely right; keep the list short enough to read. */
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
 * medium candidate and at most MAX_LOW_CANDIDATES low ones.
 */
export function orderCandidates<T extends RankedCandidate>(ranked: T[]): T[] {
  ranked.sort(
    (a, b) =>
      CONFIDENCE_ORDER[a.candidate.confidence] - CONFIDENCE_ORDER[b.candidate.confidence] ||
      a.sortKey - b.sortKey ||
      (a.candidate.source === b.candidate.source ? 0 : a.candidate.source === 'system' ? -1 : 1) ||
      compareText(a.candidate.name, b.candidate.name),
  );
  return [
    ...ranked.filter((r) => r.candidate.confidence !== 'low'),
    ...ranked.filter((r) => r.candidate.confidence === 'low').slice(0, MAX_LOW_CANDIDATES),
  ];
}

/** The single high candidate, or among several the one the orphan's base_id names. */
export function preselection<T extends RankedCandidate>(ranked: readonly T[]): T | undefined {
  const high = ranked.filter((r) => r.candidate.confidence === 'high');
  if (high.length === 1) return high[0];
  const named = high.filter((r) => r.fromBaseId);
  return named.length === 1 ? named[0] : undefined;
}

/**
 * The opening sentence of an orphan's explanation. A parent that is in the index but not
 * instantiable (a template such as fdm_process_common) exists, but Studio can't use it as a
 * parent (see studioNameLookup).
 */
export function missingIntro(missing: string, system: SystemIndex): string {
  const where = system.version
    ? `in Bambu Studio's system presets (version ${system.version})`
    : "in Bambu Studio's system presets";
  if (system.has(missing)) {
    return (
      `This preset is based on "${missing}", which is an internal template ${where} that ` +
      "presets can't be based on, so Studio hides it."
    );
  }
  return `This preset is based on "${missing}", which no longer exists ${where}, so Studio hides it.`;
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

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function eqi(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
}
