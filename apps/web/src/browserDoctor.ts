/**
 * The web version of the desktop's DoctorService (apps/desktop/src/main/service.ts): the same
 * scan / plan / apply / backup semantics, run in the page over a folder the user picked.
 *
 * Differences, all because this is a browser:
 * - It works on a copy of the Bambu Studio folder (Chromium refuses %APPDATA%), and the user
 *   copies the changed files back by hand.
 * - It can't see processes, so studioStatus() is always 'unknown' and the UI asks the user to
 *   confirm that Studio is closed before Fix or Restore.
 * - Backups go into a preset-doctor-backups folder inside the picked folder, and can be downloaded.
 *   Every repair makes its own backup, since the copy may be refreshed between repairs.
 */
import {
  applyChanges,
  ApplyError,
  assertBackupCovers,
  BackupCoverageError,
  BackupSourceError,
  createBackup,
  defaultChoices,
  FixError,
  isBackupId,
  isNotFound,
  listBackups,
  planFixes,
  restoreBackup,
  RestoreError,
  scan,
  ScanError,
  StaleChangeError,
  STUDIO_CONF_PATH,
  unifiedDiff,
  type BackupInfo,
  type Change,
  type FixChoice,
  type PresetFs,
  type ScanResult,
} from '@preset-doctor/core';
import type {
  AppConfig,
  ApplyPayload,
  IpcError,
  IpcErrorCode,
  IpcResult,
  PlanOptions,
  PlanPayload,
  PresetDoctorApi,
  RestoreOptions,
  RestorePayload,
  ScanPayload,
  StudioState,
} from '@preset-doctor/ui/contract';
import { ensureWritePermission, type ShowDirectoryPicker } from './fsaTypes';
import { fsaFs } from './fsaFs';
import type { HandleStore } from './handleStore';
import { scopedFs } from './scopedFs';

/** Subfolder of the picked folder that holds the backup zips. */
export const BACKUPS_DIR = 'preset-doctor-backups';
const STUDIO_FOLDER = '%APPDATA%\\BambuStudio';
const MAX_PLANS = 50;

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

class Refusal extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
    readonly extra: Partial<IpcError> = {},
  ) {
    super(message);
  }
}

export class BrowserDoctor implements PresetDoctorApi {
  private folder: Dir | null = null;
  private loaded: Promise<void> | null = null;
  private lastScan: { folder: Dir; result: ScanResult } | null = null;
  private readonly plans = new Map<string, { folder: Dir; changes: Change[] }>();
  /** Writes (apply, restore) run one at a time. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BrowserDeps) {}

  getConfig(): Promise<IpcResult<AppConfig>> {
    return run(async () => {
      await this.load();
      return {
        platform: 'web',
        root: this.folder?.name ?? '',
        rootExists: this.folder !== null,
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
      try {
        // Not swallowed like exists(): a folder deleted since it was picked is "not found".
        await fs.list('');
        await checkCopy(fs, folder.name);
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
      if (!(await fs.exists(STUDIO_CONF_PATH))) {
        result.warnings.push(
          `${STUDIO_CONF_PATH} wasn't copied, so Preset Doctor can't tell whether preset sync ` +
            'is on. If it is, turn it off or log out of Studio before copying the files back.',
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
      const parsed = parseChoices(choices);
      const updateBaseId = (options as Partial<PlanOptions> | null)?.updateBaseId !== false;
      const changes = await planFixes(fsaFs(last.folder, { readOnly: true }), last.result, parsed, {
        updateBaseId,
      });
      const planId = (this.deps.newId ?? (() => crypto.randomUUID()))();
      this.plans.set(planId, { folder: last.folder, changes });
      while (this.plans.size > MAX_PLANS) this.plans.delete(this.plans.keys().next().value!);
      return {
        planId,
        changes: changes.map((c) => ({
          path: c.path,
          description: c.description,
          diff: unifiedDiff(c),
        })),
      };
    });
  }

  apply(planId: string): Promise<IpcResult<ApplyPayload>> {
    return this.serialized(async () => {
      const plan = typeof planId === 'string' ? this.plans.get(planId) : undefined;
      if (!plan) throw invalid('This preview is out of date. Scan again, then try the repair.');
      if (plan.changes.length === 0) throw invalid('There is nothing to repair in this selection.');
      await this.requireWriteAccess(plan.folder);

      // Every repair gets its own backup (unlike the desktop app, which makes one per session):
      // between repairs the user copies files back, opens Studio, and may copy a fresh `user`
      // folder into the copy, which an earlier backup wouldn't match.
      const now = this.deps.now?.();
      const backup = await createBackup(fsaFs(plan.folder), backupsFs(plan.folder, false), {
        reason: 'before-fix',
        sourceRoot: plan.folder.name,
        ...(now ? { now } : {}),
      });
      // Whatever happens next, the files no longer match any other preview.
      this.plans.clear();
      try {
        assertBackupCovers(
          backup,
          plan.changes.map((c) => c.path),
        );
        const { written } = await applyChanges(fsaFs(plan.folder), plan.changes);
        return { written, backup, backupIsNew: true };
      } catch (err) {
        if (err instanceof BackupCoverageError) throw new Refusal('failed', err.message);
        if (err instanceof StaleChangeError) {
          throw new Refusal(
            'stale',
            'Some files changed since the scan, so nothing was written. Scan again and retry.',
          );
        }
        if (err instanceof ApplyError) {
          throw new Refusal(
            'partial',
            `${err.message}. Some files were already changed; restore backup ${backup.id} to undo.`,
            { written: err.written, backupId: backup.id },
          );
        }
        throw err;
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
    return this.serialized(async () => {
      const folder = await this.checkRoot(root);
      if (typeof backupId !== 'string' || !isBackupId(backupId)) throw invalid('Bad backup name.');
      await this.requireWriteAccess(folder);
      this.plans.clear();
      const now = this.deps.now?.();
      let result;
      try {
        result = await restoreBackup(fsaFs(folder), backupsFs(folder, false), backupId, {
          expectedRoot: folder.name,
          allowOtherSource: options?.allowOtherSource === true,
          ...(now ? { now } : {}),
        });
      } catch (err) {
        if (err instanceof BackupSourceError) throw new Refusal('other-source', err.message);
        if (err instanceof RestoreError) throw restoreRefusal(err);
        throw err;
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
    if (!this.folder) throw invalid('Choose your copied Bambu Studio folder first.');
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

  private serialized<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
    const next = this.writeQueue.then(() => run(fn));
    this.writeQueue = next;
    return next;
  }
}

function backupsFs(folder: Dir, readOnly: boolean): PresetFs {
  return scopedFs(fsaFs(folder, { readOnly }), BACKUPS_DIR);
}

async function looksLikeStudio(folder: Dir): Promise<boolean> {
  const fs = fsaFs(folder, { readOnly: true });
  return (await fs.exists('system/BBL.json')) || (await fs.exists('user'));
}

/**
 * People often copy the whole BambuStudio folder into the new one; then use the inner folder.
 * (A browser can't go up from a picked user\ or system\ folder, so checkCopy explains that.)
 */
async function adoptFolder(picked: Dir): Promise<Dir> {
  if (await looksLikeStudio(picked)) return picked;
  try {
    for await (const entry of picked.values()) {
      if (
        entry.kind === 'directory' &&
        entry.name.toLowerCase() === 'bambustudio' &&
        (await looksLikeStudio(entry))
      ) {
        return entry;
      }
    }
  } catch {
    // Unreadable: scan explains what's missing.
  }
  return picked;
}

/** The copy needs system\BBL.json and user\; say exactly what to copy when one is missing. */
async function checkCopy(fs: PresetFs, name: string): Promise<void> {
  const hasSystem = await fs.exists('system/BBL.json');
  const hasUser = await fs.exists('user');
  if (hasSystem && hasUser) return;
  const lower = name.toLowerCase();
  let message: string;
  if (!hasSystem && !hasUser && (lower === 'user' || lower === 'system')) {
    message =
      `You picked the "${name}" folder itself. Choose the folder you copied it into instead: ` +
      'the one that holds "system", "user" and BambuStudio.conf.';
  } else if (!hasSystem && !hasUser) {
    message =
      `"${name}" doesn't contain Bambu Studio's files. Copy the "system" and "user" folders ` +
      `and BambuStudio.conf from ${STUDIO_FOLDER} into it, then click Scan again.`;
  } else if (!hasSystem) {
    message =
      `"${name}" has no system\\BBL.json. Copy the "system" folder from ${STUDIO_FOLDER} ` +
      'into it too, then click Scan again. Preset Doctor needs it to find the presets yours ' +
      'are based on.';
  } else {
    message =
      `"${name}" has no "user" folder. Copy the "user" folder from ${STUDIO_FOLDER} into it ` +
      "too, then click Scan again. That's where your own presets are.";
  }
  throw new ScanError(message);
}

/** A restore that stopped part-way: say which backup undoes the part that was done. */
function restoreRefusal(err: RestoreError): Refusal {
  return new Refusal(
    'partial',
    err.message +
      (err.safetyBackup ? '' : ' Restore the same backup again once the problem is fixed.'),
    {
      written: err.restored,
      ...(err.safetyBackup ? { backupId: err.safetyBackup.id } : {}),
    },
  );
}

function invalid(message: string): Refusal {
  return new Refusal('invalid', message);
}

function needsPermission(folder: { name: string }): Refusal {
  return invalid(
    `Preset Doctor needs permission to open "${folder.name}". Click Scan and choose Allow, ` +
      'then try again.',
  );
}

function parseChoices(value: unknown): FixChoice[] {
  if (!Array.isArray(value)) throw invalid('Bad fix selection.');
  return value.map((v: unknown) => {
    const c = v as Partial<Record<keyof FixChoice, unknown>> | null;
    if (!c || typeof c.presetPath !== 'string') throw invalid('Bad fix selection.');
    const choice: FixChoice = { presetPath: c.presetPath };
    if (typeof c.candidateName === 'string') choice.candidateName = c.candidateName;
    if (c.rename === true) choice.rename = true;
    return choice;
  });
}

async function run<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof Refusal) {
      return { ok: false, error: { code: err.code, message: err.message, ...err.extra } };
    }
    if (err instanceof FixError) {
      return {
        ok: false,
        error: { code: err.stale ? 'stale' : 'invalid', message: err.message },
      };
    }
    if ((err as { name?: unknown } | null)?.name === 'NotAllowedError') {
      return {
        ok: false,
        error: {
          code: 'invalid',
          message:
            "The browser didn't allow Preset Doctor to open the folder. Click Scan and choose " +
            'Allow, then try again.',
        },
      };
    }
    return { ok: false, error: { code: 'failed', message: (err as Error).message } };
  }
}
