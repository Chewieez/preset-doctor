/**
 * Turning findings into file edits, and writing them.
 *
 * planFixes only reads: it returns Change records (before/after text) that the UI and the CLI
 * dry run both show as diffs. Edits are minimal (one JSON value each) so a diff is one line.
 * applyChanges writes them, refusing if any file changed since it was planned.
 *
 * Defaults for SPEC section 10's open questions. Bambu Studio's source answers each of them
 * (2-4 confirmed in Studio 02.09.01.70 on Nov 7, 2026; SPEC section 10); citations are at
 * v02.09.01.70 (56a57d00):
 *   1. base_id: updated to the new parent's setting_id, which is what Studio writes for a
 *      freshly created preset (it fills an empty base_id only, Preset.cpp:1985-1986, 2772-2773;
 *      when inherits changes, Studio itself leaves base_id stale);
 *      `updateBaseId: false` / CLI `--no-base-id` turns that off. Studio never uses base_id to
 *      find a parent (only `inherits`, src/libslic3r/Preset.cpp:1516); it is cloud-sync metadata
 *      (Preset.cpp:1703-1709, 1923). Never set equal to setting_id (Preset.cpp:1563).
 *   2. Hidden vs "Unsupported": R1 says "Studio hides it". Studio skips an orphan while loading
 *      ("can not find parent", Preset.cpp:1528-1531), so it is in no list at all.
 *   3. Cloud sync: sync_info and updated_time are never touched. A cloud copy that still names
 *      the missing parent is skipped too (Preset.cpp:2112-2124), so it can't undo the repair;
 *      but the repair is usually not uploaded either: Studio skips a preset with no sidecar
 *      (inherits set, base_id empty) and one whose sidecar has a setting_id and an empty
 *      sync_info (get_user_presets, Preset.cpp:1922-1926). The exceptions upload on their own: a
 *      sidecar with a base_id but no setting_id yet, or with sync_info = create/update pending
 *      (src/slic3r/GUI/GUI_App.cpp:6849-6877). Saving the preset in Studio uploads it
 *      (src/slic3r/GUI/Tab.cpp:7733-7743). Scan says so (R5).
 *   4. Caches: none exist on disk (PresetBundle.cpp:900-930 rescans the folders on every load),
 *      so none are cleared; the CLI asks the user to reopen Studio and check.
 */
import {
  bytesEqual,
  encodeText,
  errorMessage,
  InvalidUtf8Error,
  isFolderError,
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
  setJsonStringArray,
  setJsonStringField,
  tryParseJsonFile,
} from './jsonFile.js';
import { joinList } from './rules/r1Common.js';
import { processPrintersNote } from './rules/r1Process.js';
import { slicerById } from './slicer.js';
import { TERMS } from './terms.js';
import type {
  Candidate,
  Change,
  Finding,
  NozzleOffer,
  PresetSummary,
  ScanResult,
} from './types.js';
import { infoPathFor } from './userScan.js';

export interface FixChoice {
  /** presetPath of the finding(s) to fix. */
  presetPath: string;
  /** New parent for an R1 finding; must be one of its candidates. */
  candidateName?: string;
  /** Apply the finding's renamePreset fix (R4 name/file mismatch). */
  rename?: boolean;
  /**
   * Offer the filament for the other added nozzle sizes of its printer too: compatible_printers
   * becomes the scan's moreNozzles.printers (see nozzleOffer in compat.ts).
   */
  allNozzles?: boolean;
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
      // Studio keeps the preset's own name here too: an array for filament, a string otherwise.
      const ids = TERMS[typeOf(summary)].settingsIdKey;
      const current = json[ids.key];
      if (ids.shape === 'array0' && Array.isArray(current) && current[0] === oldName) {
        after = setJsonArrayStringItem(after, ids.key, 0, newName);
      } else if (ids.shape === 'string' && current === oldName) {
        after = setJsonStringField(after, ids.key, newName);
      }
      notes.push(`rename it from "${oldName ?? ''}" to "${newName}"`);
    }

    if (choice.allNozzles) {
      const compat = summary.compat;
      const offer = compat?.moreNozzles;
      if (!compat || !offer) {
        throw new FixError(`${summary.path} has no other nozzle sizes to be offered for.`);
      }
      // The list must still be the one the scan saw: the preset's own, or none (inherited).
      const own = json['compatible_printers'];
      const same =
        compat.source.kind === 'own'
          ? Array.isArray(own) &&
            // The scan keeps only the strings of the list.
            sameList(
              own.filter((x) => typeof x === 'string'),
              compat.printers,
            )
          : own === undefined;
      if (!same) {
        throw new FixError(
          `${summary.path} changed since the scan ("compatible_printers" is different). Scan again.`,
          true,
        );
      }
      after = setJsonStringArray(after, 'compatible_printers', offer.printers);
      notes.push(`offer it for ${nozzleWords(offer)} too`);
    }

    // The edits are byte splices; make sure the result is still valid JSON before offering it.
    if (!tryParseJsonFile(after).ok) throw new FixError(`Fixing ${summary.path} would break it.`);

    const info = newParent && updateBaseId ? await baseIdChange(fs, summary.path, newParent) : null;
    if (after !== before) {
      let description = `${capitalize(joinNotes(notes))}.`;
      // A process is offered only for its parent's printers, so a new parent can change them.
      if (newParent?.printers && typeOf(summary) === 'process') {
        description += ` ${processPrintersNote(newParent.printers)}`;
      }
      if (info?.skipped !== undefined) description += ` ${info.skipped}`;
      // Older scan results (and tests) may not say which slicer; that is Bambu Studio.
      description = slicerById(scan.slicer ?? 'bambu').reword(description);
      changes.push({ path: summary.path, before, after, description });
    }
    if (info?.change) changes.push(info.change);
  }
  return changes;
}

/** The base_id edit for one preset, or why its sidecar was left alone. */
interface BaseIdResult {
  change?: Change;
  /**
   * A sentence for the preset's own change, saying why base_id was left alone although the
   * sidecar exists: it could not be read, or its setting_id is already the new parent's id.
   */
  skipped?: string;
}

/**
 * base_id is optional (see PlanOptions), so a sidecar that can't be read or edited safely (locked or
 * a folder of that name, which R4 reports; or not valid UTF-8, which only the change description
 * mentions) is left alone instead of failing the whole plan, which would block every other repair
 * too. The inherits edit still goes ahead.
 */
async function baseIdChange(
  fs: PresetFs,
  presetPath: string,
  parent: Candidate,
): Promise<BaseIdResult | null> {
  if (parent.settingId === undefined || parent.source === 'user') return null;
  const infoPath = infoPathFor(presetPath);
  let before: string;
  try {
    // Strict for the same reason as readExact: the edit must change only the base_id line.
    before = await readTextStrict(fs, infoPath);
  } catch (err) {
    if (isNotFound(err)) return null;
    const why =
      err instanceof InvalidUtf8Error
        ? 'is not valid UTF-8 text'
        : isFolderError(err)
          ? 'is a folder, not a file'
          : `couldn't be read (${errorMessage(err)})`;
    return { skipped: `Its sync file (.info) ${why}, so its base_id is left as it is.` };
  }
  const info = parseInfoFile(before);
  const current = getInfoValue(info, INFO_KEYS.baseId);
  if (current === undefined || current === parent.settingId) return null;
  // Studio treats base_id == setting_id as a broken sidecar: it clears setting_id on load
  // (src/libslic3r/Preset.cpp:1563@v02.09.01.70) and before an upload
  // (src/slic3r/GUI/GUI_App.cpp:6914-6917), which cuts the preset off from its cloud copy.
  if (getInfoValue(info, INFO_KEYS.settingId)?.trim() === parent.settingId) {
    return {
      skipped:
        "Its sync file's setting_id is already the new parent's id, so its base_id is left as " +
        'it is.',
    };
  }
  return {
    change: {
      path: infoPath,
      before,
      after: serializeInfoFile(setInfoValue(info, INFO_KEYS.baseId, parent.settingId)),
      description: `Point the sync file's base_id at the new parent (${current || 'empty'} -> ${parent.settingId}).`,
    },
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
  // Keyed by type too: parents resolve within one type, so a process may share a filament's name.
  const key = (p: PresetSummary, name: string): string => `${typeOf(p)}\u0000${name}`;
  const renamed = new Map<string, string>();
  for (const c of choices) {
    const p = c.rename ? scan.presets.find((x) => x.path === c.presetPath) : undefined;
    if (p?.name !== undefined) renamed.set(key(p, p.name), c.presetPath);
  }
  for (const c of choices) {
    const child = scan.presets.find((p) => p.path === c.presetPath);
    if (c.candidateName === undefined || !child || !renamed.has(key(child, c.candidateName))) {
      continue;
    }
    throw new FixError(
      `"${c.candidateName}" is renamed in the same repair, so it can't also be the new parent ` +
        `of "${child.name ?? c.presetPath}". Leave out one of the two.`,
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

/** A scan from before preset types (or a hand-made one in a test) has only filament rows. */
function typeOf(p: PresetSummary): PresetSummary['type'] {
  return p.type ?? 'filament';
}

function sameList(a: readonly unknown[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** "the Bambu Lab X2D 0.2, 0.6 and 0.8 mm nozzles", one part per printer model. */
export function nozzleWords(offer: NozzleOffer): string {
  const parts = offer.models.map(
    (m) => `the ${m.model} ${joinList(m.add, 'and')} mm nozzle${m.add.length === 1 ? '' : 's'}`,
  );
  return joinList(parts, 'and');
}

function joinNotes(notes: string[]): string {
  return notes.length <= 1 ? (notes[0] ?? 'no change') : notes.join(' and ');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
