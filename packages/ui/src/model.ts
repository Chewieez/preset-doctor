/** Pure helpers that turn a scan into what the table and detail panel show. */
import type {
  Candidate,
  CompatContext,
  CompatDetail,
  Finding,
  FixChoice,
  PresetStatus,
  PresetSummary,
  PresetType,
  RuleId,
  ScanResult,
  SlicerId,
} from '@preset-doctor/core';
import { ORCA_FOLDER, STUDIO_FOLDER } from './links';

// Not imported from core: this module only takes types from it. `satisfies` keeps it in step.
export const CLOUD_SYNC_RULE = 'R5_CLOUD_SYNC' satisfies RuleId;
/** The grouped "for another printer you've added" note (scan-level, like R5). */
export const NOT_FOR_SELECTION_RULE = 'R3_NOT_FOR_SELECTION' satisfies RuleId;

/** Search text that lists exactly the presets the grouped note counts. */
export const COMPAT_OTHER_QUERY = 'compat:other';

export const SLICER_NAME: Record<SlicerId, string> = {
  bambu: 'Bambu Studio',
  orca: 'OrcaSlicer',
};

/** What the UI says about a slicer. Bambu Studio's are the texts from before OrcaSlicer support. */
export interface SlicerText {
  id: SlicerId;
  name: string;
  /** In running text after the name was used once: 'Studio' or 'OrcaSlicer'. */
  short: string;
  /** Its data folder, as typed into File Explorer's address bar. */
  folder: string;
  /** That folder's own name. */
  dirName: string;
  conf: string;
  /** The system index whose absence means "no system presets", Windows-style. */
  index: string;
}

export const SLICER_TEXT: Record<SlicerId, SlicerText> = {
  bambu: {
    id: 'bambu',
    name: 'Bambu Studio',
    short: 'Studio',
    folder: STUDIO_FOLDER,
    dirName: 'BambuStudio',
    conf: 'BambuStudio.conf',
    index: 'system\\BBL.json',
  },
  orca: {
    id: 'orca',
    name: 'OrcaSlicer',
    short: 'OrcaSlicer',
    folder: ORCA_FOLDER,
    dirName: 'OrcaSlicer',
    conf: 'OrcaSlicer.conf',
    index: 'system\\OrcaFilamentLibrary.json',
  },
};

/** The slicer whose default folder `root` is (desktop), compared as Windows does; else undefined. */
export function slicerOfRoot(
  slicers: readonly { id: SlicerId; root: string }[],
  root: string,
): SlicerId | undefined {
  const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase();
  return slicers.find((s) => norm(s.root) === norm(root))?.id;
}

/** The tab order, as in core's PRESET_TYPES. */
export const PRESET_TYPE_ORDER = [
  'filament',
  'process',
  'machine',
] as const satisfies readonly PresetType[];

/** The UI's copy of core's TERMS (packages/core/src/terms.ts); the filament strings are the old ones. */
export const TYPE_TERMS: Record<PresetType, { tab: string; noun: string; baseTag: string }> = {
  filament: { tab: 'Filament', noun: 'filament preset', baseTag: 'custom filament' },
  process: { tab: 'Process', noun: 'process preset', baseTag: 'custom process' },
  machine: { tab: 'Printer', noun: 'printer preset', baseTag: 'custom printer' },
};

export const STATUS_LABEL: Record<PresetStatus, string> = {
  ok: 'OK',
  hidden: 'Hidden',
  broken: 'Broken',
  info: 'Info',
  // The word the slicer itself uses for the group these presets sit in.
  unsupported: 'Unsupported',
};

const STATUS_ORDER: Record<PresetStatus, number> = {
  hidden: 0,
  broken: 1,
  unsupported: 2,
  info: 3,
  ok: 4,
};

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

/**
 * Needs attention: Studio can't show it, it isn't offered for any added printer, or Preset
 * Doctor has a repair for it.
 */
export function isProblem(p: PresetSummary, byPath: Map<string, Finding[]>): boolean {
  return (
    p.status === 'hidden' ||
    p.status === 'broken' ||
    p.status === 'unsupported' ||
    hasFix(fixesFor(byPath.get(p.path) ?? []))
  );
}

/** Findings with a repair first, then the most serious, then the worst status. */
export function orderFindings(findings: readonly Finding[]): Finding[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...findings].sort(
    (a, b) =>
      Number(b.proposedFix !== undefined) - Number(a.proposedFix !== undefined) ||
      rank[a.severity] - rank[b.severity] ||
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  );
}

export function displayName(p: PresetSummary): string {
  return p.name ?? p.fileStem;
}

/** A row's preset type; rows from before preset types are filament. */
export function typeOf(p: PresetSummary): PresetType {
  return p.type ?? 'filament';
}

/** Rows of one tab; every row when `tab` is undefined. */
export function presetsOfType(scan: ScanResult, tab: PresetType | undefined): PresetSummary[] {
  return tab === undefined ? scan.presets : scan.presets.filter((p) => typeOf(p) === tab);
}

export function visiblePresets(
  scan: ScanResult,
  byPath: Map<string, Finding[]>,
  filter: Filter,
  search: string,
  tab?: PresetType,
): PresetSummary[] {
  const q = search.trim().toLowerCase();
  const other = q === COMPAT_OTHER_QUERY;
  return presetsOfType(scan, tab)
    .filter((p) => filter === 'all' || isProblem(p, byPath))
    .filter((p) =>
      other
        ? p.compat !== undefined && isForOtherSelection(p.compat)
        : q === '' || displayName(p).toLowerCase().includes(q),
    )
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' }),
    );
}

export function countByType(scan: ScanResult): Record<PresetType, number> {
  const counts: Record<PresetType, number> = { filament: 0, process: 0, machine: 0 };
  for (const p of scan.presets) counts[typeOf(p)]++;
  return counts;
}

/** Rows that need attention (see isProblem), per type. */
export function problemsByType(
  scan: ScanResult,
  byPath: Map<string, Finding[]>,
): Record<PresetType, number> {
  const counts: Record<PresetType, number> = { filament: 0, process: 0, machine: 0 };
  for (const p of scan.presets) if (isProblem(p, byPath)) counts[typeOf(p)]++;
  return counts;
}

/** Types with at least one preset, in tab order. Tabs are shown only when there are two or more. */
export function presetTabs(scan: ScanResult): PresetType[] {
  const counts = countByType(scan);
  return PRESET_TYPE_ORDER.filter((t) => counts[t] > 0);
}

/** The tab to open: the first with a row needing attention, else the first with presets. */
export function defaultTab(scan: ScanResult, byPath: Map<string, Finding[]>): PresetType {
  const problems = problemsByType(scan, byPath);
  const tabs = presetTabs(scan);
  return tabs.find((t) => problems[t] > 0) ?? tabs[0] ?? 'filament';
}

export function countByStatus(scan: ScanResult): Record<PresetStatus, number> {
  const counts: Record<PresetStatus, number> = {
    ok: 0,
    hidden: 0,
    broken: 0,
    info: 0,
    unsupported: 0,
  };
  for (const p of scan.presets) counts[p.status]++;
  return counts;
}

export function cloudSyncFinding(scan: ScanResult): Finding | undefined {
  return scan.findings.find((f) => f.ruleId === CLOUD_SYNC_RULE);
}

export function notForSelectionFinding(scan: ScanResult): Finding | undefined {
  return scan.findings.find((f) => f.ruleId === NOT_FOR_SELECTION_RULE);
}

/** Counted in the grouped note: made for another added printer, or another process. */
export function isForOtherSelection(c: CompatDetail): boolean {
  return c.state === 'other-printer' || c.process === 'mismatch';
}

/** Rows the grouped note's "Show them" lists (see COMPAT_OTHER_QUERY), across every tab. */
export function forOtherSelection(scan: ScanResult): PresetSummary[] {
  return scan.presets.filter((p) => p.compat !== undefined && isForOtherSelection(p.compat));
}

/** "Bambu Lab X2D" -> "X2D": the brand adds nothing when every model is Bambu's. */
export function shortModel(model: string): string {
  return model.startsWith('Bambu Lab ') ? model.slice('Bambu Lab '.length) : model;
}

/** The printers strip: what is added, or why the printer checks were skipped. */
export function printersText(compat: CompatContext | undefined, slicer: string): string {
  if (!compat) return '';
  if (!compat.checked) return `Printer checks skipped: ${skipReason(compat, slicer)}.`;
  const parts = compat.enabled.map((m) => `${shortModel(m.model)} (${m.nozzles.join(', ')} mm)`);
  if (compat.userPrinters > 0) {
    parts.push(
      `${compat.userPrinters} printer preset${compat.userPrinters === 1 ? '' : 's'} of your own`,
    );
  }
  const added = parts.length > 0 ? parts.join(' · ') : 'none';
  const selected =
    compat.selectedPrinter !== undefined ? ` Selected: ${shortModel(compat.selectedPrinter)}.` : '';
  return `Printers added in ${slicer}: ${added}.${selected}`;
}

function skipReason(compat: CompatContext, slicer: string): string {
  switch (compat.why) {
    case 'no-conf':
      return `${slicer}'s settings file wasn't found, so Preset Doctor doesn't know which printers you've added`;
    case 'conf-unreadable':
      return `${slicer}'s settings file couldn't be read`;
    case 'system-unreadable':
      return `${slicer}'s system printer presets couldn't be read`;
    default:
      return `${slicer}'s settings don't list the printers you've added`;
  }
}

/** Plain words for the printer list in the detail panel. */
export function compatLines(c: CompatDetail, slicer: string): string[] {
  const lines: string[] = [];
  lines.push(
    c.printers.length === 0
      ? 'Offered for: every printer.'
      : `Offered for: ${c.printers.join(', ')}.`,
  );
  switch (c.source.kind) {
    case 'own':
      lines.push('This list is in the preset itself.');
      break;
    case 'inherited':
      lines.push(`This list comes from "${c.source.from}", the preset it is based on.`);
      break;
    case 'name':
      lines.push(`This list comes from the preset's name (after "@"), as ${slicer} reads it.`);
      break;
    case 'default':
      break;
  }
  if (c.state === 'selected') lines.push('It is offered for the printer selected now.');
  if (c.state === 'other-printer') {
    lines.push(`${slicer} shows it when you select ${(c.matchedPrinters ?? []).join(' or ')}.`);
  }
  if (c.state === 'cant-tell') {
    lines.push(
      c.why === 'opaque'
        ? "Preset Doctor can't read the presets this one is based on, so it can't tell which printers it is for."
        : `It uses a rule (compatible_printers_condition) that ${slicer} checks itself; Preset Doctor can't evaluate it.`,
    );
  }
  if (c.process === 'mismatch') {
    lines.push('It is only for other process presets than the one selected now.');
  }
  if (c.process === 'cant-tell') {
    lines.push(`Which process presets it is for depends on a rule ${slicer} checks itself.`);
  }
  return lines;
}

export function accountLabel(id: string, count: number): string {
  const who = id === 'default' ? 'Not signed in (default)' : `Account ${id}`;
  return `${who}: ${count} preset${count === 1 ? '' : 's'}`;
}

/** Number of preset files (not sidecars) among written paths. */
export function presetFilesIn(paths: readonly string[]): number {
  return paths.filter((p) => p.toLowerCase().endsWith('.json')).length;
}

/** Title and lines of a result banner. */
export interface NoticeText {
  title: string;
  lines: string[];
}

/** The banner after a repair. `backupsDir` is where the web version keeps its backups. */
export function repairNotice(
  r: { written: readonly string[]; backup: { id: string }; backupIsNew: boolean },
  ctx: { web: boolean; cloud: boolean; backupsDir: string; slicer?: SlicerId },
): NoticeText {
  const n = presetFilesIn(r.written);
  const where = ctx.web ? `, in the ${ctx.backupsDir} folder` : '';
  const s = SLICER_TEXT[ctx.slicer ?? 'bambu'];
  return {
    title: `Repaired ${n} preset${n === 1 ? '' : 's'}.`,
    lines: [
      r.backupIsNew
        ? `Your presets were backed up first (backup ${r.backup.id}${where}).`
        : `Your presets were already backed up earlier in this session (backup ${r.backup.id}${where}).`,
      ctx.web
        ? `Next: copy the repaired files back into ${s.name} (see below), then open ${s.short} and check that your presets are back.`
        : `Next: open ${s.name} and check that your presets are back. If anything looks wrong, use "Restore a backup".`,
      ...(ctx.cloud
        ? [
            `Cloud sync is on: to upload a repair to your other computers, open the preset in ${s.name} and save it.`,
          ]
        : []),
    ],
  };
}

/**
 * The banner after a restore that put `count` files back. `skipped`: OrcaSlicer sync files left
 * out, because putting them back alone would delete the preset in the cloud.
 */
export function restoreNotice(
  backupId: string,
  count: number,
  web: boolean,
  slicer: SlicerId = 'bambu',
  skipped = 0,
): NoticeText {
  return {
    title: `Restored backup ${backupId}.`,
    lines: [
      `${count} files were put back. The state before the restore was backed up too.`,
      ...(skipped > 0
        ? [
            // The CLI's skippedNote (packages/core/src/cli.ts), same words.
            `${skipped} sync file${skipped === 1 ? ' was' : 's were'} not put back because ` +
              `${skipped === 1 ? 'its preset is' : 'their presets are'} gone, and restoring ` +
              `them alone could make ${SLICER_TEXT[slicer].name} delete those presets from your cloud.`,
          ]
        : []),
      ...(web
        ? [`Copy the user folder back into ${SLICER_TEXT[slicer].name} to finish (see below).`]
        : []),
    ],
  };
}

/** A '/'-joined path as Windows shows it: `user/1/a.json` -> `user\1\a.json`. */
export function windowsPath(path: string): string {
  return path.split('/').join('\\');
}

/** Both lists of changed files together, each path once, sorted. */
export function mergePaths(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}
