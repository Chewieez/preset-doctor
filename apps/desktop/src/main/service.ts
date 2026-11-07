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
  detectSlicer,
  findStale,
  isBackupId,
  listBackups,
  missingFromBackup,
  planFixes,
  restoreBackup,
  scan,
  ScanError,
  slicerById,
  SLICERS,
  type BackupInfo,
  type PresetFs,
  type ScanResult,
  type SlicerId,
  type SlicerProfile,
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
  /** Whether that slicer is running. Throws when the process list can't be read. */
  isStudioRunning: (slicer: SlicerId) => Promise<boolean>;
  version: string;
  donationUrl: string;
  now?: () => Date;
  /** Opens a folder as a PresetFs. Default nodeFs; tests wrap it. */
  fsFor?: (root: string, options?: NodeFsOptions) => PresetFs;
}

export class DoctorService {
  private readonly allowedRoots = new Map<string, string>();
  private lastScan: { root: string; result: ScanResult } | null = null;
  /**
   * The folder the UI shows: the one last asked to be scanned (even if that scan failed) or
   * picked. studioStatus watches its slicer.
   */
  private shownRoot: string | null = null;
  /** Previews, keyed to the Studio folder they were planned for. */
  private readonly plans = new PlanStore<string>();
  private readonly sessions = new Map<string, BackupSession>();
  /** Set when a Studio check saw it running; the next repair then makes a fresh backup. */
  private studioSeenRunning = false;
  /** Writes (apply, restore) run one at a time. */
  private readonly writes = new WriteQueue();

  constructor(private readonly deps: ServiceDeps) {
    this.allow(deps.config.root);
    // Switching slicers scans the other default folder (docs/design-v0.2.md section 7.1).
    for (const r of Object.values(deps.config.slicerRoots)) if (r) this.allow(r);
  }

  /** Lets the UI scan a folder the user picked. Only allowed folders can be scanned. */
  async adoptFolder(picked: string): Promise<string> {
    let root = nodePath.resolve(picked);
    // People often pick the user\ or system\ folder itself; use the slicer folder above it.
    const base = nodePath.basename(root).toLowerCase();
    if (base === 'user' || base === 'system') {
      const parent = nodePath.dirname(root);
      if (
        (await isDir(nodePath.join(parent, 'user'))) ||
        (await isDir(nodePath.join(parent, 'system'))) ||
        (await isFile(nodePath.join(parent, slicerById('orca').confFile)))
      ) {
        root = parent;
      }
    }
    this.allow(root);
    // Nothing may target the previous folder after a folder change, even if the next scan fails.
    this.lastScan = null;
    this.plans.clear();
    this.show(nodePath.resolve(root));
    return root;
  }

  getConfig(): Promise<IpcResult<AppConfig>> {
    return run(async () => {
      const { config } = this.deps;
      const slicers = await Promise.all(
        SLICERS.map(async (s) => {
          // Test mode without PRESET_DOCTOR_<SLICER>_ROOT: no folder to switch to.
          const r = config.slicerRoots[s.id] ?? '';
          return {
            id: s.id,
            displayName: s.displayName,
            root: r,
            exists: r !== '' && (await isDir(r)),
          };
        }),
      );
      let root = config.root;
      let rootExists = await isDir(root);
      // No Bambu Studio folder, but an OrcaSlicer one: start there.
      const orca = slicers.find((s) => s.id === 'orca');
      if (!config.testMode && !rootExists && orca?.exists) {
        root = orca.root;
        rootExists = true;
      }
      // The folder the UI starts on, until it scans or picks one.
      if (this.shownRoot === null) this.shownRoot = nodePath.resolve(root);
      return {
        root,
        rootExists,
        slicers,
        backupsDir: config.backupsDir,
        platform: 'desktop' as const,
        testMode: config.testMode,
        version: this.deps.version,
        donationUrl: this.deps.donationUrl,
      };
    });
  }

  scan(root: unknown, userId: unknown): Promise<IpcResult<ScanPayload>> {
    return run(async () => {
      const dir = this.checkRoot(root);
      if (userId !== undefined && typeof userId !== 'string') throw invalid('Bad account id.');
      this.show(dir);
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
      const slicer = await this.requireStudioClosed(root);
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
      let session = this.sessionFor(root, slicer);
      let backupIsNew = session.backup === null;
      let backup = await session.ensureBackupOnce();
      // Whatever happens next, the files no longer match any other preview.
      this.plans.clear();
      const paths = plan.changes.map((c) => c.path);
      // A file the session's backup doesn't hold (added since) gets a fresh backup first.
      if (!backupIsNew && missingFromBackup(backup, paths).length > 0) {
        this.sessions.delete(rootKey(root));
        session = this.sessionFor(root, slicer);
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
      const slicer = await this.requireStudioClosed(dir);
      this.plans.clear();
      const now = this.deps.now?.();
      let result;
      try {
        result = await restoreBackup(this.fs(dir), this.fs(this.deps.config.backupsDir), backupId, {
          expectedRoot: dir,
          allowOtherSource,
          slicer,
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

  /** The state of the slicer of the folder the UI shows (shownRoot), which labels the pill. */
  studioStatus(): Promise<IpcResult<StudioState>> {
    return run(
      async () =>
        (await this.studioState(this.shownRoot ?? this.lastScan?.root ?? this.deps.config.root))
          .state,
    );
  }

  /** Creates the backups folder if needed and returns it, for "Open backups folder". */
  async ensureBackupsDir(): Promise<string> {
    await fsp.mkdir(this.deps.config.backupsDir, { recursive: true });
    return this.deps.config.backupsDir;
  }

  /**
   * The slicer whose folder `root` is, read from its files now, else the last scan's. Null when
   * neither tells (the running check then covers both slicers).
   */
  private async slicerOf(root: string): Promise<SlicerProfile | null> {
    const found = await detectSlicer(this.fs(root, { readOnly: true })).catch(() => null);
    if (found?.ok) return found.profile;
    const last = this.lastScan;
    return last && rootKey(last.root) === rootKey(nodePath.resolve(root))
      ? slicerById(last.result.slicer)
      : null;
  }

  /**
   * Whether the slicer of `root` is running, for writes to `root`. The test-mode fake answer only
   * applies to the folder the app was started on (PRESET_DOCTOR_ROOT), never to a folder picked
   * later. `name` is the slicer to name in a refusal.
   */
  private async studioState(
    root: string,
  ): Promise<{ state: StudioState; slicer: SlicerProfile | null; name: string }> {
    const slicer = await this.slicerOf(root);
    const fake = this.deps.config.fakeStudioRunning;
    const names = (slicer ? [slicer] : SLICERS).map((s) => s.displayName).join(' or ');
    let state: StudioState;
    let name = names;
    if (
      fake !== null &&
      rootKey(nodePath.resolve(root)) === rootKey(nodePath.resolve(this.deps.config.root))
    ) {
      state = fake ? 'running' : 'closed';
    } else {
      state = 'closed';
      // A folder whose slicer can't be told: neither slicer may be running.
      for (const s of slicer ? [slicer] : SLICERS) {
        try {
          if (await this.deps.isStudioRunning(s.id)) {
            state = 'running';
            name = s.displayName;
            break;
          }
        } catch {
          state = 'unknown';
        }
      }
    }
    if (state === 'running') this.studioSeenRunning = true;
    return { state, slicer, name };
  }

  /** Refuses unless the slicer of `root` is closed; returns that slicer (Bambu Studio if unknown). */
  private async requireStudioClosed(root: string): Promise<SlicerId> {
    const { state, slicer, name } = await this.studioState(root);
    if (state === 'running') {
      throw new Refusal(
        'studio-running',
        `${name} is open. Close it completely, then try again. Nothing was changed.`,
      );
    }
    if (state === 'unknown') {
      throw new Refusal(
        'studio-unknown',
        `Couldn't check whether ${name} is running, so nothing was changed.`,
      );
    }
    return slicer?.id ?? 'bambu';
  }

  /**
   * Records the folder the UI shows. On a change, every backup session is dropped: the poll only
   * watches the shown folder's slicer, so the other slicer may run (and change its files) unseen.
   * A session is then only reused for a folder whose slicer was watched since its backup.
   */
  private show(dir: string): void {
    if (this.shownRoot === null || rootKey(this.shownRoot) !== rootKey(dir)) {
      this.sessions.clear();
    }
    this.shownRoot = dir;
  }

  private sessionFor(root: string, slicer: SlicerId): BackupSession {
    const key = rootKey(root);
    let s = this.sessions.get(key);
    if (!s) {
      const now = this.deps.now;
      s = new BackupSession(this.fs(root), this.fs(this.deps.config.backupsDir), {
        reason: 'before-fix',
        sourceRoot: root,
        slicer,
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

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
