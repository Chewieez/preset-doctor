/**
 * Everything the main process does for the UI, without any Electron imports so it can be tested
 * on its own. Each method returns an IpcResult instead of throwing, because errors thrown across
 * Electron IPC lose their type and get a noisy prefix.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';
import {
  applyChanges,
  assertBackupCovers,
  BackupSession,
  defaultChoices,
  findStale,
  isBackupId,
  listBackups,
  missingFromBackup,
  planFixes,
  restoreBackup,
  scan,
  ScanError,
  type BackupInfo,
  type PresetFs,
  type ScanResult,
} from '@preset-doctor/core';
import { nodeFs, type NodeFsOptions } from '@preset-doctor/core/node';
import {
  applyFailure,
  invalid,
  parseChoices,
  parsePlanOptions,
  PlanStore,
  Refusal,
  restoreFailure,
  run,
  staleRefusal,
  WriteQueue,
} from '@preset-doctor/ui/service';
import type {
  AppConfig,
  ApplyPayload,
  IpcResult,
  PlanPayload,
  RestoreOptions,
  RestorePayload,
  ScanPayload,
  StudioState,
} from '../shared/api.js';
import type { MainConfig } from './config.js';

export interface ServiceDeps {
  config: MainConfig;
  /** Throws when the process list can't be read. */
  isStudioRunning: () => Promise<boolean>;
  version: string;
  donationUrl: string;
  now?: () => Date;
  /** Opens a folder as a PresetFs. Default nodeFs; tests wrap it. */
  fsFor?: (root: string, options?: NodeFsOptions) => PresetFs;
}

export class DoctorService {
  private readonly allowedRoots = new Map<string, string>();
  private lastScan: { root: string; result: ScanResult } | null = null;
  /** Previews, keyed to the Studio folder they were planned for. */
  private readonly plans = new PlanStore<string>();
  private readonly sessions = new Map<string, BackupSession>();
  /** Set when a Studio check saw it running; the next repair then makes a fresh backup. */
  private studioSeenRunning = false;
  /** Writes (apply, restore) run one at a time. */
  private readonly writes = new WriteQueue();

  constructor(private readonly deps: ServiceDeps) {
    this.allow(deps.config.root);
  }

  /** Lets the UI scan a folder the user picked. Only allowed folders can be scanned. */
  async adoptFolder(picked: string): Promise<string> {
    let root = nodePath.resolve(picked);
    // People often pick the user\ or system\ folder itself; use the Studio folder above it.
    const base = nodePath.basename(root).toLowerCase();
    if (base === 'user' || base === 'system') {
      const parent = nodePath.dirname(root);
      if (
        (await isDir(nodePath.join(parent, 'user'))) ||
        (await isDir(nodePath.join(parent, 'system')))
      ) {
        root = parent;
      }
    }
    this.allow(root);
    // Nothing may target the previous folder after a folder change, even if the next scan fails.
    this.lastScan = null;
    this.plans.clear();
    return root;
  }

  getConfig(): Promise<IpcResult<AppConfig>> {
    return run(async () => ({
      root: this.deps.config.root,
      rootExists: await isDir(this.deps.config.root),
      backupsDir: this.deps.config.backupsDir,
      platform: 'desktop',
      testMode: this.deps.config.testMode,
      version: this.deps.version,
      donationUrl: this.deps.donationUrl,
    }));
  }

  scan(root: unknown, userId: unknown): Promise<IpcResult<ScanPayload>> {
    return run(async () => {
      const dir = this.checkRoot(root);
      if (userId !== undefined && typeof userId !== 'string') throw invalid('Bad account id.');
      if (!(await isDir(dir))) {
        throw new Refusal('scan-failed', `The folder ${dir} does not exist.`);
      }
      const fs = this.fs(dir, { readOnly: true });
      let result: ScanResult;
      try {
        result = await scan(fs, userId ? { root: dir, userId } : { root: dir });
      } catch (err) {
        if (err instanceof ScanError) throw new Refusal('scan-failed', err.message);
        throw err;
      }
      this.lastScan = { root: dir, result };
      this.plans.clear();
      return { result, defaults: defaultChoices(result) };
    });
  }

  plan(choices: unknown, options: unknown): Promise<IpcResult<PlanPayload>> {
    return run(async () => {
      const last = this.lastScan;
      if (!last) throw invalid('Scan first.');
      const changes = await planFixes(
        this.fs(last.root, { readOnly: true }),
        last.result,
        parseChoices(choices),
        parsePlanOptions(options),
      );
      return this.plans.add(last.root, changes, randomUUID());
    });
  }

  apply(planId: unknown): Promise<IpcResult<ApplyPayload>> {
    return this.writes.run(async () => {
      const plan = this.plans.get(planId);
      if (!plan) throw invalid('This preview is out of date. Scan again, then try the repair.');
      if (plan.changes.length === 0) throw invalid('There is nothing to repair in this selection.');
      const root = plan.key;
      await this.requireStudioClosed(root);
      // Before any backup: a file deleted since the scan is "changed", not "missing from the
      // backup", and needs no new backup to be refused.
      if ((await findStale(this.fs(root, { readOnly: true }), plan.changes)).length > 0) {
        this.plans.clear();
        throw staleRefusal();
      }

      // Studio ran since the last backup, so it may have changed files the backup doesn't cover.
      if (this.studioSeenRunning) {
        this.sessions.clear();
        this.studioSeenRunning = false;
      }
      let session = this.sessionFor(root);
      let backupIsNew = session.backup === null;
      let backup = await session.ensureBackupOnce();
      // Whatever happens next, the files no longer match any other preview.
      this.plans.clear();
      const paths = plan.changes.map((c) => c.path);
      // A file the session's backup doesn't hold (added since) gets a fresh backup first.
      if (!backupIsNew && missingFromBackup(backup, paths).length > 0) {
        this.sessions.delete(rootKey(root));
        session = this.sessionFor(root);
        backupIsNew = true;
        backup = await session.ensureBackupOnce();
      }
      // Never write what the backup can't undo (e.g. files behind a link it couldn't follow).
      try {
        assertBackupCovers(backup, paths);
      } catch (err) {
        this.sessions.delete(rootKey(root));
        throw applyFailure(err, backup.id) ?? err;
      }
      try {
        const { written } = await applyChanges(this.fs(root), plan.changes);
        return { written, backup, backupIsNew };
      } catch (err) {
        throw applyFailure(err, backup.id) ?? err;
      }
    });
  }

  listBackups(): Promise<IpcResult<BackupInfo[]>> {
    return run(() => listBackups(this.fs(this.deps.config.backupsDir, { readOnly: true })));
  }

  /** Restores into `root`, the folder the UI shows; it must be one the UI was allowed to scan. */
  restore(root: unknown, backupId: unknown, options?: unknown): Promise<IpcResult<RestorePayload>> {
    return this.writes.run(async () => {
      const dir = this.checkRoot(root);
      if (typeof backupId !== 'string' || !isBackupId(backupId)) throw invalid('Bad backup name.');
      const allowOtherSource = (options as RestoreOptions | null)?.allowOtherSource === true;
      await this.requireStudioClosed(dir);
      this.plans.clear();
      const now = this.deps.now?.();
      let result;
      try {
        result = await restoreBackup(this.fs(dir), this.fs(this.deps.config.backupsDir), backupId, {
          expectedRoot: dir,
          allowOtherSource,
          ...(now ? { now } : {}),
        });
      } catch (err) {
        throw restoreFailure(err) ?? err;
      } finally {
        // The files may no longer match this session's backup; the next repair makes a new one.
        this.sessions.delete(rootKey(dir));
      }
      return { ...result, backupId };
    });
  }

  studioStatus(): Promise<IpcResult<StudioState>> {
    return run(() => this.studioState(this.lastScan?.root ?? this.deps.config.root));
  }

  /** Creates the backups folder if needed and returns it, for "Open backups folder". */
  async ensureBackupsDir(): Promise<string> {
    await fsp.mkdir(this.deps.config.backupsDir, { recursive: true });
    return this.deps.config.backupsDir;
  }

  /**
   * Whether Studio is running, for writes to `root`. The test-mode fake answer only applies to
   * the folder the app was started on (PRESET_DOCTOR_ROOT), never to a folder picked later.
   */
  private async studioState(root: string): Promise<StudioState> {
    const fake = this.deps.config.fakeStudioRunning;
    let state: StudioState;
    if (
      fake !== null &&
      rootKey(nodePath.resolve(root)) === rootKey(nodePath.resolve(this.deps.config.root))
    ) {
      state = fake ? 'running' : 'closed';
    } else {
      try {
        state = (await this.deps.isStudioRunning()) ? 'running' : 'closed';
      } catch {
        state = 'unknown';
      }
    }
    if (state === 'running') this.studioSeenRunning = true;
    return state;
  }

  private async requireStudioClosed(root: string): Promise<void> {
    const state = await this.studioState(root);
    if (state === 'running') {
      throw new Refusal(
        'studio-running',
        'Bambu Studio is open. Close it completely, then try again. Nothing was changed.',
      );
    }
    if (state === 'unknown') {
      throw new Refusal(
        'studio-unknown',
        "Couldn't check whether Bambu Studio is running, so nothing was changed.",
      );
    }
  }

  private sessionFor(root: string): BackupSession {
    const key = rootKey(root);
    let s = this.sessions.get(key);
    if (!s) {
      const now = this.deps.now;
      s = new BackupSession(this.fs(root), this.fs(this.deps.config.backupsDir), {
        reason: 'before-fix',
        sourceRoot: root,
        ...(now ? { now: now() } : {}),
      });
      this.sessions.set(key, s);
    }
    return s;
  }

  private allow(root: string): void {
    const abs = nodePath.resolve(root);
    this.allowedRoots.set(rootKey(abs), abs);
  }

  private checkRoot(root: unknown): string {
    if (typeof root !== 'string' || root === '') throw invalid('No folder given.');
    const abs = this.allowedRoots.get(rootKey(nodePath.resolve(root)));
    if (!abs) throw invalid('Choose this folder with "Change folder" first.');
    return abs;
  }

  private fs(root: string, options?: NodeFsOptions): PresetFs {
    return (this.deps.fsFor ?? nodeFs)(root, options);
  }
}

function rootKey(abs: string): string {
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
