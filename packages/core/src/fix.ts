/**
 * Turning findings into file edits, and writing them.
 *
 * planFixes only reads: it returns Change records (before/after text) that the UI and the CLI
 * dry run both show as diffs. Edits are minimal (one JSON value each) so a diff is one line.
 * applyChanges writes them, refusing if any file changed since it was planned.
 *
 * Defaults for SPEC section 10's open questions, which need a person watching Studio to settle:
 *   1. base_id: updated to the new parent's setting_id (Studio writes it that way itself);
 *      `updateBaseId: false` / CLI `--no-base-id` turns that off.
 *   2. Hidden vs "Unsupported": R1 says "Studio hides it".
 *   3. Cloud sync: updated_time is never touched; scan warns (R5) when sync is on.
 *   4. Caches: none are cleared; the CLI asks the user to reopen Studio and check.
 */
import {
  bytesEqual,
  encodeText,
  errorMessage,
  InvalidUtf8Error,
  isNotFound,
  readTextStrict,
  type PresetFs,
} from './fs.js';
import {
  getInfoValue,
  INFO_KEYS,
  parseInfoFile,
  serializeInfoFile,
  setInfoValue,
} from './infoFile.js';
import {
  isRecord,
  setJsonArrayStringItem,
  setJsonStringField,
  tryParseJsonFile,
} from './jsonFile.js';
import type { Candidate, Change, Finding, PresetSummary, ScanResult } from './types.js';
import { infoPathFor } from './userScan.js';

export interface FixChoice {
  /** presetPath of the finding(s) to fix. */
  presetPath: string;
  /** New parent for an R1 finding; must be one of its candidates. */
  candidateName?: string;
  /** Apply the finding's renamePreset fix (R4 name/file mismatch). */
  rename?: boolean;
}

export interface PlanOptions {
  /**
   * Also set base_id in the .info sidecar to the new parent's setting_id (Studio writes it that
   * way itself). Default true. Only existing sidecars with a base_id line are touched.
   */
  updateBaseId?: boolean;
}

/** A choice that doesn't match the scan, or a file that changed since the scan. */
export class FixError extends Error {
  constructor(
    message: string,
    /** True when the file changed after the scan, so a fresh scan would help. */
    readonly stale = false,
  ) {
    super(message);
    this.name = 'FixError';
  }
}

/** The fixes Preset Doctor would make on its own: pre-selected candidates and renames. */
export function defaultChoices(scan: ScanResult): FixChoice[] {
  const byPath = new Map<string, FixChoice>();
  const choiceFor = (path: string): FixChoice => {
    let c = byPath.get(path);
    if (!c) byPath.set(path, (c = { presetPath: path }));
    return c;
  };
  for (const f of scan.findings) {
    const fix = f.proposedFix;
    if (fix?.kind === 'setInherits') {
      const pick = fix.candidates.find((c) => c.preselected);
      if (pick) choiceFor(f.presetPath).candidateName = pick.name;
    } else if (fix?.kind === 'renamePreset') {
      choiceFor(f.presetPath).rename = true;
    }
  }
  return [...byPath.values()];
}

/** Builds the edits for the chosen fixes. Reads current file contents; writes nothing. */
export async function planFixes(
  fs: PresetFs,
  scan: ScanResult,
  choices: readonly FixChoice[],
  options: PlanOptions = {},
): Promise<Change[]> {
  const updateBaseId = options.updateBaseId ?? true;
  const changes: Change[] = [];
  const merged = mergeChoices(choices);
  checkRenamedParents(scan, merged);

  for (const choice of merged) {
    const summary = scan.presets.find((p) => p.path === choice.presetPath);
    if (!summary) throw new FixError(`"${choice.presetPath}" was not part of this scan.`);
    const before = await readExact(fs, summary.path);
    const parsed = tryParseJsonFile(before);
    if (!parsed.ok || !isRecord(parsed.value)) {
      throw new FixError(`${summary.path} can no longer be read. Scan again.`, true);
    }
    const json = parsed.value;
    let after = before;
    const notes: string[] = [];
    let newParent: Candidate | undefined;

    if (choice.candidateName !== undefined) {
      newParent = pickCandidate(scan.findings, summary, choice.candidateName);
      expectUnchanged(summary, 'inherits', json['inherits'], summary.inherits);
      after = setJsonStringField(after, 'inherits', newParent.name);
      notes.push(`set its parent to "${newParent.name}" (was "${summary.inherits ?? ''}")`);
    }

    if (choice.rename) {
      const newName = renameTarget(scan.findings, summary);
      const oldName = summary.name;
      expectUnchanged(summary, 'name', json['name'], oldName);
      after = setJsonStringField(after, 'name', newName);
      const ids = json['filament_settings_id'];
      if (Array.isArray(ids) && ids[0] === oldName) {
        after = setJsonArrayStringItem(after, 'filament_settings_id', 0, newName);
      }
      notes.push(`rename it from "${oldName ?? ''}" to "${newName}"`);
    }

    // The edits are byte splices; make sure the result is still valid JSON before offering it.
    if (!tryParseJsonFile(after).ok) throw new FixError(`Fixing ${summary.path} would break it.`);
    if (after !== before) {
      changes.push({
        path: summary.path,
        before,
        after,
        description: `${capitalize(joinNotes(notes))}.`,
      });
    }

    if (newParent && updateBaseId) {
      const info = await baseIdChange(fs, summary.path, newParent);
      if (info) changes.push(info);
    }
  }
  return changes;
}

async function baseIdChange(
  fs: PresetFs,
  presetPath: string,
  parent: Candidate,
): Promise<Change | null> {
  if (parent.settingId === undefined || parent.source === 'user') return null;
  const infoPath = infoPathFor(presetPath);
  let before: string;
  try {
    before = await readExact(fs, infoPath);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const info = parseInfoFile(before);
  const current = getInfoValue(info, INFO_KEYS.baseId);
  if (current === undefined || current === parent.settingId) return null;
  return {
    path: infoPath,
    before,
    after: serializeInfoFile(setInfoValue(info, INFO_KEYS.baseId, parent.settingId)),
    description: `Point the sync file's base_id at the new parent (${current || 'empty'} -> ${parent.settingId}).`,
  };
}

/**
 * Reads a file that is about to be edited. Edits work on decoded text, so a file whose bytes
 * don't survive decode + encode (invalid UTF-8) would have more than one value changed; refuse.
 */
async function readExact(fs: PresetFs, path: string): Promise<string> {
  try {
    return await readTextStrict(fs, path);
  } catch (err) {
    if (!(err instanceof InvalidUtf8Error)) throw err;
    throw new FixError(
      `${path} is not valid UTF-8 text, so Preset Doctor won't edit it (that would change more ` +
        'than the one setting). Restore it from a backup, or recreate the preset in Bambu Studio.',
    );
  }
}

/**
 * Refuses a selection that re-parents a preset onto one that the same selection renames: the
 * orphan would then point at a name that no longer exists.
 */
function checkRenamedParents(scan: ScanResult, choices: readonly FixChoice[]): void {
  const renamed = new Map<string, string>();
  for (const c of choices) {
    const name = c.rename ? scan.presets.find((p) => p.path === c.presetPath)?.name : undefined;
    if (name !== undefined) renamed.set(name, c.presetPath);
  }
  for (const c of choices) {
    if (c.candidateName === undefined || !renamed.has(c.candidateName)) continue;
    const child = scan.presets.find((p) => p.path === c.presetPath);
    throw new FixError(
      `"${c.candidateName}" is renamed in the same repair, so it can't also be the new parent ` +
        `of "${child?.name ?? c.presetPath}". Leave out one of the two.`,
    );
  }
}

function mergeChoices(choices: readonly FixChoice[]): FixChoice[] {
  const byPath = new Map<string, FixChoice>();
  for (const c of choices) {
    const prev = byPath.get(c.presetPath);
    const merged: FixChoice = { ...prev, ...c };
    if (prev?.rename || c.rename) merged.rename = true;
    byPath.set(c.presetPath, merged);
  }
  return [...byPath.values()];
}

function pickCandidate(findings: Finding[], summary: PresetSummary, name: string): Candidate {
  for (const f of findings) {
    if (f.presetPath !== summary.path || f.proposedFix?.kind !== 'setInherits') continue;
    const c = f.proposedFix.candidates.find((x) => x.name === name);
    if (c) return c;
  }
  throw new FixError(`"${name}" is not one of the suggested parents for ${summary.path}.`);
}

function renameTarget(findings: Finding[], summary: PresetSummary): string {
  for (const f of findings) {
    if (f.presetPath === summary.path && f.proposedFix?.kind === 'renamePreset') {
      return f.proposedFix.newName;
    }
  }
  throw new FixError(`There is no rename to apply for ${summary.path}.`);
}

function expectUnchanged(
  summary: PresetSummary,
  key: string,
  actual: unknown,
  expected: string | undefined,
): void {
  if (actual !== expected) {
    throw new FixError(
      `${summary.path} changed since the scan ("${key}" is different). Scan again.`,
      true,
    );
  }
}

/** One or more planned files changed on disk after planning; nothing was written. */
export class StaleChangeError extends Error {
  constructor(readonly paths: string[]) {
    super(
      `These files changed since the fix was planned, so nothing was written: ${paths.join(', ')}. Scan again.`,
    );
    this.name = 'StaleChangeError';
  }
}

/**
 * A write failed part-way. `written` lists the files already changed, including the failing one
 * unless it is provably untouched (restore a backup).
 */
export class ApplyError extends Error {
  constructor(
    message: string,
    readonly written: string[],
  ) {
    super(message);
    this.name = 'ApplyError';
  }
}

export interface ApplyResult {
  written: string[];
}

/**
 * The planned files that no longer hold their `before` text (or are gone). Callers check this
 * before making a backup, so a file deleted since the scan is reported as changed, not as
 * missing from the backup; applyChanges checks it again right before writing.
 */
export async function findStale(fs: PresetFs, changes: readonly Change[]): Promise<string[]> {
  // Bytes, not decoded text: invalid UTF-8 decodes lossily, so text equality could hide a change.
  const stale: string[] = [];
  for (const c of changes) {
    let current: Uint8Array | undefined;
    try {
      current = await fs.readBytes(c.path);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    if (!current || !bytesEqual(current, encodeText(c.before))) stale.push(c.path);
  }
  return stale;
}

/**
 * Writes the changes. First re-reads every file and refuses all of them (StaleChangeError) if
 * any no longer matches `before`; then writes each one and reads it back.
 */
export async function applyChanges(fs: PresetFs, changes: readonly Change[]): Promise<ApplyResult> {
  const paths = changes.map((c) => c.path);
  const dup = paths.find((p, i) => paths.indexOf(p) !== i);
  if (dup !== undefined) throw new FixError(`More than one change for ${dup}.`);

  const stale = await findStale(fs, changes);
  if (stale.length > 0) throw new StaleChangeError(stale);

  const written: string[] = [];
  for (const c of changes) {
    const after = encodeText(c.after);
    try {
      await fs.writeText(c.path, c.after);
      if (!bytesEqual(await fs.readBytes(c.path), after)) {
        throw new Error('read-back did not match');
      }
    } catch (err) {
      // The write may have replaced the file before failing (e.g. the read-back hit a locked
      // file), so list it unless the file is provably still as it was.
      let unchanged = false;
      try {
        unchanged = bytesEqual(await fs.readBytes(c.path), encodeText(c.before));
      } catch {
        // Can't tell: report it as changed.
      }
      throw new ApplyError(
        `Could not write ${c.path}: ${errorMessage(err)}`,
        unchanged ? written : [...written, c.path],
      );
    }
    written.push(c.path);
  }
  return { written };
}

function joinNotes(notes: string[]): string {
  return notes.length <= 1 ? (notes[0] ?? 'no change') : notes.join(' and ');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
