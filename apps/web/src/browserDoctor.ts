/**
 * The web version of the desktop's DoctorService (apps/desktop/src/main/service.ts): the same
 * scan / plan / apply / backup semantics, run in the page over a folder the user picked.
 *
 * Differences, all because this is a browser:
 * - It works on a copy of the Bambu Studio or OrcaSlicer folder (Chromium refuses %APPDATA%), and
 *   the user copies the changed files back by hand. The copy's files tell which slicer it is.
 * - It can't see processes, so studioStatus() is always 'unknown' and the UI asks the user to
 *   confirm that the slicer is closed before Fix or Restore.
 * - Backups go into a preset-doctor-backups folder inside the picked folder, and can be downloaded.
 *   Every repair makes its own backup, since the copy may be refreshed between repairs.
 */
import {
  applyChanges,
  assertBackupCovers,
  createBackup,
  defaultChoices,
  detectSlicer,
  findStale,
  isBackupId,
  isNotFound,
  listBackups,
  planFixes,
  restoreBackup,
  scan,
  ScanError,
  slicerById,
  type BackupInfo,
  type FixChoice,
  type PresetFs,
  type ScanResult,
  type SlicerProfile,
} from '@preset-doctor/core';
import type {
  AppConfig,
  ApplyPayload,
  IpcError,
  IpcResult,
  PlanOptions,
  PlanPayload,
  PresetDoctorApi,
  RestoreOptions,
  RestorePayload,
  ScanPayload,
  StudioState,
} from '@preset-doctor/ui/contract';
import { ORCA_FOLDER, STUDIO_FOLDER } from '@preset-doctor/ui/links';
import {
  applyFailure,
  invalid,
  parseChoices,
  parsePlanOptions,
  PlanStore,
  Refusal,
  restoreFailure,
  run as runShared,
  staleRefusal,
  WriteQueue,
} from '@preset-doctor/ui/service';
import { ensureWritePermission, type ShowDirectoryPicker } from './fsaTypes';
import { fsaFs } from './fsaFs';
import type { HandleStore } from './handleStore';
import { scopedFs } from './scopedFs';

/** Subfolder of the picked folder that holds the backup zips. */
export const BACKUPS_DIR = 'preset-doctor-backups';

export interface BrowserDeps {
  /** window.showDirectoryPicker, or undefined when the browser has none. */
  showDirectoryPicker: ShowDirectoryPicker | undefined;
  handles: HandleStore;
  /** Hands a file to the browser's downloads. */
  download: (fileName: string, data: Uint8Array) => void;
  version: string;
  now?: () => Date;
  /** Plan ids. Default crypto.randomUUID. */
  newId?: () => string;
}

type Dir = FileSystemDirectoryHandle;

export class BrowserDoctor implements PresetDoctorApi {
  private folder: Dir | null = null;
  private loaded: Promise<void> | null = null;
  private lastScan: { folder: Dir; result: ScanResult } | null = null;
  /** Previews, keyed to the folder they were planned for. */
  private readonly plans = new PlanStore<Dir>();
  /** Writes (apply, restore) run one at a time. */
  private readonly writes = new WriteQueue(browserError);

  constructor(private readonly deps: BrowserDeps) {}

  getConfig(): Promise<IpcResult<AppConfig>> {
    return run(async () => {
      await this.load();
      return {
        platform: 'web',
        root: this.folder?.name ?? '',
        rootExists: this.folder !== null,
        // The picked folder's files tell the slicer; there are no default folders to switch to.
        slicers: [],
        backupsDir: BACKUPS_DIR,
        testMode: false,
        version: this.deps.version,
        donationUrl: '',
      };
    });
  }

  scan(root: string, userId?: string): Promise<IpcResult<ScanPayload>> {
    return run(async () => {
      const folder = await this.checkRoot(root);
      if (userId !== undefined && typeof userId !== 'string') throw invalid('Bad account id.');
      // Asked here, on the Scan click, so Fix doesn't need a second prompt later.
      if (!(await ensureWritePermission(folder))) {
        throw new Refusal(
          'scan-failed',
          `Preset Doctor needs permission to view and edit files in "${folder.name}". ` +
            'Click Scan again and choose Allow, or choose the folder again.',
        );
      }
      const fs = fsaFs(folder, { readOnly: true });
      let result: ScanResult;
      let profile: SlicerProfile;
      try {
        // Not swallowed like exists(): a folder deleted since it was picked is "not found".
        await fs.list('');
        profile = await checkCopy(fs, folder.name);
        result = await scan(fs, userId ? { root: folder.name, userId } : { root: folder.name });
      } catch (err) {
        if (err instanceof ScanError) throw new Refusal('scan-failed', err.message);
        if (isNotFound(err)) {
          throw new Refusal(
            'scan-failed',
            `"${folder.name}" can't be read anymore. If you moved or deleted it, choose it again.`,
          );
        }
        throw err;
      }
      if (!(await fs.exists(profile.confFile))) {
        result.warnings.push(
          profile.reword(
            `${profile.confFile} wasn't copied, so Preset Doctor can't tell whether preset sync ` +
              'is on. If it is, a repair stays on this computer until you save the preset in Studio.',
          ),
        );
      }
      this.lastScan = { folder, result };
      this.plans.clear();
      return { result, defaults: defaultChoices(result) };
    });
  }

  plan(choices: FixChoice[], options: PlanOptions): Promise<IpcResult<PlanPayload>> {
    return run(async () => {
      const last = this.lastScan;
      if (!last) throw invalid('Scan first.');
      const changes = await planFixes(
        fsaFs(last.folder, { readOnly: true }),
        last.result,
        parseChoices(choices),
        parsePlanOptions(options),
      );
      const planId = (this.deps.newId ?? (() => crypto.randomUUID()))();
      return this.plans.add(last.folder, changes, planId);
    });
  }

  apply(planId: string): Promise<IpcResult<ApplyPayload>> {
    return this.writes.run(async () => {
      const plan = this.plans.get(planId);
      if (!plan) throw invalid('This preview is out of date. Scan again, then try the repair.');
      if (plan.changes.length === 0) throw invalid('There is nothing to repair in this selection.');
      const folder = plan.key;
      await this.requireWriteAccess(folder);
      // Before the backup: a file deleted since the scan (say, a fresh `user` folder copied in)
      // is "changed", not "missing from the backup".
      if ((await findStale(fsaFs(folder, { readOnly: true }), plan.changes)).length > 0) {
        this.plans.clear();
        throw staleRefusal();
      }

      // Every repair gets its own backup (unlike the desktop app, which makes one per session):
      // between repairs the user copies files back, opens Studio, and may copy a fresh `user`
      // folder into the copy, which an earlier backup wouldn't match.
      const now = this.deps.now?.();
      const backup = await createBackup(fsaFs(folder), backupsFs(folder, false), {
        reason: 'before-fix',
        sourceRoot: folder.name,
        slicer: this.lastScan?.result.slicer ?? 'bambu',
        ...(now ? { now } : {}),
      });
      // Whatever happens next, the files no longer match any other preview.
      this.plans.clear();
      try {
        assertBackupCovers(
          backup,
          plan.changes.map((c) => c.path),
        );
        const { written } = await applyChanges(fsaFs(folder), plan.changes);
        return { written, backup, backupIsNew: true };
      } catch (err) {
        throw applyFailure(err, backup.id) ?? err;
      }
    });
  }

  listBackups(): Promise<IpcResult<BackupInfo[]>> {
    return run(async () => listBackups(backupsFs(await this.readableFolder(), true)));
  }

  restore(
    root: string,
    backupId: string,
    options?: RestoreOptions,
  ): Promise<IpcResult<RestorePayload>> {
    return this.writes.run(async () => {
      const folder = await this.checkRoot(root);
      if (typeof backupId !== 'string' || !isBackupId(backupId)) throw invalid('Bad backup name.');
      await this.requireWriteAccess(folder);
      this.plans.clear();
      const now = this.deps.now?.();
      // The files say which slicer's folder this is now; the last scan's answer if they don't.
      const last = this.lastScan;
      const slicer =
        (await slicerOf(fsaFs(folder, { readOnly: true })))?.id ??
        (last?.folder === folder ? last.result.slicer : 'bambu');
      let result;
      try {
        result = await restoreBackup(fsaFs(folder), backupsFs(folder, false), backupId, {
          expectedRoot: folder.name,
          allowOtherSource: options?.allowOtherSource === true,
          slicer,
          ...(now ? { now } : {}),
        });
      } catch (err) {
        throw restoreFailure(err) ?? err;
      }
      return { ...result, backupId };
    });
  }

  studioStatus(): Promise<IpcResult<StudioState>> {
    return Promise.resolve({ ok: true, value: 'unknown' });
  }

  pickFolder(): Promise<IpcResult<string | null>> {
    return run(async () => {
      const picker = this.deps.showDirectoryPicker;
      if (!picker) {
        throw invalid(
          "This browser can't open folders. Use Chrome or Edge, or the Windows app instead.",
        );
      }
      let picked: Dir;
      try {
        picked = await picker({ id: 'preset-doctor', mode: 'readwrite', startIn: 'documents' });
      } catch (err) {
        if ((err as { name?: unknown } | null)?.name === 'AbortError') return null;
        throw err;
      }
      const folder = await adoptFolder(picked);
      this.loaded = Promise.resolve();
      this.folder = folder;
      this.lastScan = null;
      this.plans.clear();
      await this.deps.handles.save(folder);
      return folder.name;
    });
  }

  openBackupsFolder(): Promise<IpcResult<void>> {
    return run(() => {
      throw invalid(
        `A web page can't open File Explorer. Your backups are in the ${BACKUPS_DIR} folder ` +
          'inside the folder you picked.',
      );
    });
  }

  openDonationPage(): Promise<IpcResult<void>> {
    return Promise.resolve({
      ok: false,
      error: { code: 'invalid', message: 'No donation link is set.' },
    });
  }

  downloadBackup(backupId: string): Promise<IpcResult<void>> {
    return run(async () => {
      if (typeof backupId !== 'string' || !isBackupId(backupId)) throw invalid('Bad backup name.');
      const folder = await this.readableFolder();
      let bytes: Uint8Array;
      try {
        bytes = await backupsFs(folder, true).readBytes(`${backupId}.zip`);
      } catch (err) {
        if (isNotFound(err)) throw invalid(`Backup "${backupId}" was not found.`);
        throw err;
      }
      this.deps.download(`preset-doctor-backup-${backupId}.zip`, bytes);
    });
  }

  /** Restores the folder picked on an earlier visit, once. */
  private load(): Promise<void> {
    this.loaded ??= this.deps.handles.load().then(
      (h) => {
        this.folder ??= h;
      },
      () => undefined,
    );
    return this.loaded;
  }

  private async currentFolder(): Promise<Dir> {
    await this.load();
    if (!this.folder) throw invalid('Choose your copied Bambu Studio or OrcaSlicer folder first.');
    return this.folder;
  }

  /**
   * The picked folder, with permission asked for if needed: after a reload a remembered folder
   * is back to "ask", and reading it would fail with a raw browser error.
   */
  private async readableFolder(): Promise<Dir> {
    const folder = await this.currentFolder();
    if (!(await ensureWritePermission(folder))) throw needsPermission(folder);
    return folder;
  }

  private async checkRoot(root: unknown): Promise<Dir> {
    if (typeof root !== 'string' || root === '') throw invalid('No folder given.');
    const folder = await this.currentFolder();
    if (folder.name !== root) throw invalid('Choose this folder with "Change folder" first.');
    return folder;
  }

  private async requireWriteAccess(folder: Dir): Promise<void> {
    if (!(await ensureWritePermission(folder))) {
      throw new Refusal(
        'invalid',
        `Preset Doctor isn't allowed to change files in "${folder.name}", so nothing was changed. ` +
          'Scan again and choose Allow when the browser asks.',
      );
    }
  }
}

function backupsFs(folder: Dir, readOnly: boolean): PresetFs {
  return scopedFs(fsaFs(folder, { readOnly }), BACKUPS_DIR);
}

/** The slicer the folder's files belong to; null when they don't tell (or say both). */
async function slicerOf(fs: PresetFs): Promise<SlicerProfile | null> {
  const found = await detectSlicer(fs).catch(() => null);
  return found?.ok ? found.profile : null;
}

async function looksLikeSlicerFolder(folder: Dir): Promise<boolean> {
  const fs = fsaFs(folder, { readOnly: true });
  return (await slicerOf(fs)) !== null || (await fs.exists('user'));
}

/** Folder names a whole slicer folder copied into the picked one would have. */
const INNER_FOLDERS = ['bambustudio', 'orcaslicer'];

/**
 * People often copy the whole BambuStudio or OrcaSlicer folder into the new one; then use the
 * inner folder. (A browser can't go up from a picked user\ or system\ folder, so checkCopy
 * explains that.)
 */
async function adoptFolder(picked: Dir): Promise<Dir> {
  if (await looksLikeSlicerFolder(picked)) return picked;
  try {
    for await (const entry of picked.values()) {
      if (
        entry.kind === 'directory' &&
        INNER_FOLDERS.includes(entry.name.toLowerCase()) &&
        (await looksLikeSlicerFolder(entry))
      ) {
        return entry;
      }
    }
  } catch {
    // Unreadable: scan explains what's missing.
  }
  return picked;
}

/** Whether system\ holds at least one vendor index (.json, or OrcaSlicer 2.5's packed .opc). */
async function hasVendorIndex(fs: PresetFs): Promise<boolean> {
  try {
    return (await fs.list('system')).some(
      (e) => e.kind === 'file' && /\.(json|opc)$/i.test(e.name),
    );
  } catch {
    return false;
  }
}

/**
 * The copy needs the system presets and user\; say exactly what to copy when one is missing.
 * Returns the slicer the copy belongs to. Bambu Studio's copy needs system\BBL.json, OrcaSlicer's
 * any vendor index in system\.
 */
async function checkCopy(fs: PresetFs, name: string): Promise<SlicerProfile> {
  const detected = await detectSlicer(fs);
  // Both apps' files in one folder: say so, before anything else.
  if (!detected.ok && detected.reason === 'both') {
    throw new ScanError(`"${name}": ${detected.message}`);
  }
  const profile = detected.ok ? detected.profile : slicerById('bambu');
  const orca = profile.id === 'orca';
  const folder = orca ? ORCA_FOLDER : STUDIO_FOLDER;
  const hasSystem = orca ? await hasVendorIndex(fs) : await fs.exists('system/BBL.json');
  const hasUser = await fs.exists('user');
  if (hasSystem && hasUser) return profile;
  const lower = name.toLowerCase();
  let message: string;
  if (!hasSystem && !hasUser && (lower === 'user' || lower === 'system')) {
    message =
      `You picked the "${name}" folder itself. Choose the folder you copied it into instead: ` +
      (detected.ok
        ? `the one that holds "system", "user" and ${profile.confFile}.`
        : 'the one that holds "system", "user" and BambuStudio.conf (or OrcaSlicer.conf).');
  } else if (!hasSystem && !hasUser) {
    message = detected.ok
      ? `"${name}" doesn't contain ${profile.displayName}'s files. Copy the "system" and "user" ` +
        `folders and ${profile.confFile} from ${folder} into it, then click Scan again.`
      : `"${name}" doesn't contain Bambu Studio's files. Copy the "system" and "user" folders ` +
        `and BambuStudio.conf from ${STUDIO_FOLDER} into it, then click Scan again. For ` +
        `OrcaSlicer, copy them and OrcaSlicer.conf from ${ORCA_FOLDER}.`;
  } else if (!hasSystem) {
    message =
      (orca
        ? `"${name}" has no system presets (a .json or .opc file in its "system" folder). `
        : `"${name}" has no system\\BBL.json. `) +
      `Copy the "system" folder from ${folder} ` +
      'into it too, then click Scan again. Preset Doctor needs it to find the presets yours ' +
      'are based on.';
  } else {
    message =
      `"${name}" has no "user" folder. Copy the "user" folder from ${folder} into it ` +
      "too, then click Scan again. That's where your own presets are.";
  }
  throw new ScanError(message);
}

function needsPermission(folder: { name: string }): Refusal {
  return invalid(
    `Preset Doctor needs permission to open "${folder.name}". Click Scan and choose Allow, ` +
      'then try again.',
  );
}

/** A permission the browser refused (a picker or permission prompt that was dismissed). */
function browserError(err: unknown): IpcError | undefined {
  if ((err as { name?: unknown } | null)?.name !== 'NotAllowedError') return undefined;
  return {
    code: 'invalid',
    message:
      "The browser didn't allow Preset Doctor to open the folder. Click Scan and choose " +
      'Allow, then try again.',
  };
}

function run<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  return runShared(fn, browserError);
}
