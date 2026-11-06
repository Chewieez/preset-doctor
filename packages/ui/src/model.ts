/** Pure helpers that turn a scan into what the table and detail panel show. */
import type {
  Candidate,
  Finding,
  FixChoice,
  PresetStatus,
  PresetSummary,
  ScanResult,
} from '@preset-doctor/core';

export const CLOUD_SYNC_RULE = 'R5_CLOUD_SYNC';

export const STATUS_LABEL: Record<PresetStatus, string> = {
  ok: 'OK',
  hidden: 'Hidden',
  broken: 'Broken',
  info: 'Info',
};

const STATUS_ORDER: Record<PresetStatus, number> = { hidden: 0, broken: 1, info: 2, ok: 3 };

export const CONFIDENCE_LABEL: Record<Candidate['confidence'], string> = {
  high: 'Best match',
  medium: 'Possible',
  low: 'Unlikely',
};

export type Filter = 'problems' | 'all';

/** Fix state per preset: chosen parent (R1) and whether the row is ticked for repair. */
export interface Selection {
  picks: Record<string, string>;
  checked: Record<string, boolean>;
}

export interface PresetFixes {
  /** Candidate parents, when the preset's parent is missing. */
  candidates?: Candidate[];
  /** New name, when the preset's name doesn't match its file. */
  rename?: string;
}

export function findingsByPath(scan: ScanResult): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const f of scan.findings) {
    const list = map.get(f.presetPath);
    if (list) list.push(f);
    else map.set(f.presetPath, [f]);
  }
  return map;
}

export function fixesFor(findings: readonly Finding[]): PresetFixes {
  const out: PresetFixes = {};
  for (const f of findings) {
    const fix = f.proposedFix;
    if (fix?.kind === 'setInherits' && fix.candidates.length > 0) out.candidates = fix.candidates;
    if (fix?.kind === 'renamePreset') out.rename = fix.newName;
  }
  return out;
}

export function hasFix(fixes: PresetFixes): boolean {
  return fixes.candidates !== undefined || fixes.rename !== undefined;
}

/** The choice to send for one preset, or null when nothing has been picked yet. */
export function choiceFor(
  path: string,
  fixes: PresetFixes,
  picks: Selection['picks'],
): FixChoice | null {
  const choice: FixChoice = { presetPath: path };
  const pick = picks[path];
  if (fixes.candidates && pick !== undefined && fixes.candidates.some((c) => c.name === pick)) {
    choice.candidateName = pick;
  }
  if (fixes.rename !== undefined) choice.rename = true;
  return choice.candidateName !== undefined || choice.rename ? choice : null;
}

/** Starting selection: Preset Doctor's own picks, all ticked. */
export function initialSelection(defaults: readonly FixChoice[]): Selection {
  const sel: Selection = { picks: {}, checked: {} };
  for (const c of defaults) {
    if (c.candidateName !== undefined) sel.picks[c.presetPath] = c.candidateName;
    sel.checked[c.presetPath] = true;
  }
  return sel;
}

export function selectedChoices(
  scan: ScanResult,
  byPath: Map<string, Finding[]>,
  sel: Selection,
): FixChoice[] {
  const out: FixChoice[] = [];
  for (const p of scan.presets) {
    if (!sel.checked[p.path]) continue;
    const c = choiceFor(p.path, fixesFor(byPath.get(p.path) ?? []), sel.picks);
    if (c) out.push(c);
  }
  return out;
}

/** Needs attention: Studio can't show it, or Preset Doctor has a repair for it. */
export function isProblem(p: PresetSummary, byPath: Map<string, Finding[]>): boolean {
  return (
    p.status === 'hidden' || p.status === 'broken' || hasFix(fixesFor(byPath.get(p.path) ?? []))
  );
}

/** Findings with a repair first, then the most serious. */
export function orderFindings(findings: readonly Finding[]): Finding[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...findings].sort(
    (a, b) =>
      Number(b.proposedFix !== undefined) - Number(a.proposedFix !== undefined) ||
      rank[a.severity] - rank[b.severity],
  );
}

export function displayName(p: PresetSummary): string {
  return p.name ?? fileStemOf(p.path);
}

export function visiblePresets(
  scan: ScanResult,
  byPath: Map<string, Finding[]>,
  filter: Filter,
  search: string,
): PresetSummary[] {
  const q = search.trim().toLowerCase();
  return scan.presets
    .filter((p) => filter === 'all' || isProblem(p, byPath))
    .filter((p) => q === '' || displayName(p).toLowerCase().includes(q))
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' }),
    );
}

export function countByStatus(scan: ScanResult): Record<PresetStatus, number> {
  const counts: Record<PresetStatus, number> = { ok: 0, hidden: 0, broken: 0, info: 0 };
  for (const p of scan.presets) counts[p.status]++;
  return counts;
}

export function cloudSyncFinding(scan: ScanResult): Finding | undefined {
  return scan.findings.find((f) => f.ruleId === CLOUD_SYNC_RULE);
}

export function accountLabel(id: string, count: number): string {
  const who = id === 'default' ? 'Not signed in (default)' : `Account ${id}`;
  return `${who}: ${count} preset${count === 1 ? '' : 's'}`;
}

/** Number of preset files (not sidecars) among written paths. */
export function presetFilesIn(paths: readonly string[]): number {
  return paths.filter((p) => p.toLowerCase().endsWith('.json')).length;
}

/** A '/'-joined path as Windows shows it: `user/1/a.json` -> `user\1\a.json`. */
export function windowsPath(path: string): string {
  return path.split('/').join('\\');
}

/** Both lists of changed files together, each path once, sorted. */
export function mergePaths(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

function fileStemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
}
