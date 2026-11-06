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
  ApplyError,
  BackupSession,
  BackupSourceError,
  defaultChoices,
  FixError,
  isBackupId,
  listBackups,
  missingFromBackup,
  planFixes,
  restoreBackup,
  RestoreError,
  scan,
  ScanError,
  StaleChangeError,
  unifiedDiff,
  type BackupInfo,
  type Change,
  type FixChoice,
  type ScanResult,
} from '@preset-doctor/core';
import { nodeFs } from '@preset-doctor/core/node';
import type {
  AppConfig,
  ApplyPayload,
  IpcError,
  IpcErrorCode,
  IpcResult,
  PlanOptions,
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
}

const MAX_PLANS = 50;

class Refusal extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
    readonly extra: Partial<IpcError> = {},
  ) {
    super(message);
  }
}

export class DoctorService {
  private readonly allowedRoots = new Map<string, string>();
  private lastScan: { root: string; result: ScanResult } | null = null;
  private readonly plans = new Map<string, { root: string; changes: Change[] }>();
  private readonly sessions = new Map<string, BackupSession>();
  /** Set when a Studio check saw it running; the next repair then makes a fresh backup. */
  private studioSeenRunning = false;
  /** Writes (apply, restore) run one at a time. */
  private writeQueue: Promise<unknown> = Promise.resolve();

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
      const fs = nodeFs(dir, { readOnly: true });
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
      const parsed = parseChoices(choices);
      const updateBaseId = (options as Partial<PlanOptions> | null)?.updateBaseId !== false;
      const changes = await planFixes(nodeFs(last.root, { readOnly: true }), last.result, parsed, {
        updateBaseId,
      });
      const planId = randomUUID();
      this.plans.set(planId, { root: last.root, changes });
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

  apply(planId: unknown): Promise<IpcResult<ApplyPayload>> {
    return this.serialized(async () => {
      const plan = typeof planId === 'string' ? this.plans.get(planId) : undefined;
      if (!plan) throw invalid('This preview is out of date. Scan again, then try the repair.');
      if (plan.changes.length === 0) throw invalid('There is nothing to repair in this selection.');
      await this.requireStudioClosed(plan.root);

      // Studio ran since the last backup, so it may have changed files the backup doesn't cover.
      if (this.studioSeenRunning) {
        this.sessions.clear();
        this.studioSeenRunning = false;
      }
      let session = this.sessionFor(plan.root);
      let backupIsNew = session.backup === null;
      let backup = await session.ensureBackupOnce();
      // Whatever happens next, the files no longer match any other preview.
      this.plans.clear();
      const paths = plan.changes.map((c) => c.path);
      // A file the session's backup doesn't hold (added since) gets a fresh backup first.
      if (!backupIsNew && missingFromBackup(backup, paths).length > 0) {
        this.sessions.delete(rootKey(plan.root));
        session = this.sessionFor(plan.root);
        backupIsNew = true;
        backup = await session.ensureBackupOnce();
      }
      // Never write what the backup can't undo (e.g. files behind a link it couldn't follow).
      const missing = missingFromBackup(backup, paths);
      if (missing.length > 0) {
        this.sessions.delete(rootKey(plan.root));
        throw new Refusal(
          'failed',
          `Backup ${backup.id} doesn't include ${missing.join(', ')}, so the repair couldn't be ` +
            'undone and nothing was written. Is part of the user folder a link to another place?',
        );
      }
      try {
        const { written } = await applyChanges(nodeFs(plan.root), plan.changes);
        return { written, backup, backupIsNew };
      } catch (err) {
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
    return run(() => listBackups(nodeFs(this.deps.config.backupsDir, { readOnly: true })));
  }

  /** Restores into `root`, the folder the UI shows; it must be one the UI was allowed to scan. */
  restore(root: unknown, backupId: unknown, options?: unknown): Promise<IpcResult<RestorePayload>> {
    return this.serialized(async () => {
      const dir = this.checkRoot(root);
      if (typeof backupId !== 'string' || !isBackupId(backupId)) throw invalid('Bad backup name.');
      const allowOtherSource = (options as RestoreOptions | null)?.allowOtherSource === true;
      await this.requireStudioClosed(dir);
      this.plans.clear();
      const now = this.deps.now?.();
      let result;
      try {
        result = await restoreBackup(nodeFs(dir), nodeFs(this.deps.config.backupsDir), backupId, {
          expectedRoot: dir,
          allowOtherSource,
          ...(now ? { now } : {}),
        });
      } catch (err) {
        if (err instanceof BackupSourceError) throw new Refusal('other-source', err.message);
        if (err instanceof RestoreError) {
          throw new Refusal(
            'partial',
            err.message +
              (err.safetyBackup ? '' : ' Restore the same backup again once the problem is fixed.'),
            {
              written: err.restored,
              ...(err.safetyBackup ? { backupId: err.safetyBackup.id } : {}),
            },
          );
        }
        throw err;
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
      s = new BackupSession(nodeFs(root), nodeFs(this.deps.config.backupsDir), {
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

  private serialized<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
    const next = this.writeQueue.then(() => run(fn));
    this.writeQueue = next;
    return next;
  }
}

function rootKey(abs: string): string {
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function invalid(message: string): Refusal {
  return new Refusal('invalid', message);
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
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

async function run<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
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
    return { ok: false, error: { code: 'failed', message: (err as Error).message } };
  }
}
