/**
 * The contract between the UI and whatever does the file work: the Electron main process (desktop)
 * or the in-browser implementation (web). The UI never touches files: it asks to scan, plan and
 * apply, and gets plain JSON back.
 *
 * Only `import type` from core here, so the desktop's sandboxed preload bundle stays tiny.
 */
import type {
  BackupInfo,
  FixChoice,
  RestoreResult,
  ScanResult,
  SlicerId,
} from '@preset-doctor/core';

export type { BackupInfo, FixChoice, RestoreResult, ScanResult, SlicerId };

/**
 * desktop: works in place on the real slicer folder and checks whether the slicer is running.
 * web: works on a copy the user picked in the browser; it can't see processes, so the user
 * confirms that the slicer is closed, and copies the changed files back by hand.
 */
export type Platform = 'desktop' | 'web';

/** A slicer whose default folder the desktop app knows. */
export interface SlicerFolder {
  id: SlicerId;
  displayName: string;
  root: string;
  exists: boolean;
}

export interface AppConfig {
  platform: Platform;
  /**
   * Folder to scan first. Desktop: PRESET_DOCTOR_ROOT, or the Bambu Studio folder when it exists,
   * otherwise the OrcaSlicer folder. Web: the name of the folder picked last time (browsers don't
   * reveal full paths), or ''.
   */
  root: string;
  rootExists: boolean;
  /**
   * Desktop: the default folder of each slicer; the header offers a switch when both exist.
   * Web: [] (the picked folder's files tell the slicer).
   */
  slicers: SlicerFolder[];
  /** Where backups go. Desktop: PRESET_DOCTOR_BACKUPS or %APPDATA%\PresetDoctor\backups. */
  backupsDir: string;
  /** True when started with PRESET_DOCTOR_ROOT (tests, or a copy of the folder). */
  testMode: boolean;
  version: string;
  /** Empty when no donation link is configured. */
  donationUrl: string;
}

export interface ScanPayload {
  result: ScanResult;
  /** The fixes Preset Doctor would pick on its own (pre-selected candidates and renames). */
  defaults: FixChoice[];
}

export interface PlannedChange {
  path: string;
  description: string;
  /** Unified diff of before -> after. */
  diff: string;
}

export interface PlanPayload {
  /** Handle for apply(). The implementation keeps the exact edits, so the UI can't alter them. */
  planId: string;
  changes: PlannedChange[];
}

export interface PlanOptions {
  updateBaseId: boolean;
}

export interface ApplyPayload {
  /** Changed files, '/'-joined and relative to the slicer folder (e.g. `user/1/...`). */
  written: string[];
  backup: BackupInfo;
  /** False when the backup was already made earlier in this session. */
  backupIsNew: boolean;
}

export interface RestorePayload extends RestoreResult {
  backupId: string;
}

export interface RestoreOptions {
  /** The user confirmed restoring a backup that was made from another folder. */
  allowOtherSource?: boolean;
}

export type StudioState = 'running' | 'closed' | 'unknown';

export type IpcErrorCode =
  /** The slicer (Bambu Studio or OrcaSlicer) is open, or we couldn't tell. Nothing was written. */
  | 'studio-running'
  | 'studio-unknown'
  /** A file changed since the scan or preview. Nothing was written. */
  | 'stale'
  /** Some files were written before a failure; `written` lists them. */
  | 'partial'
  /** Bad request from the UI (unknown plan, folder not allowed, ...). */
  | 'invalid'
  /** The folder isn't a Bambu Studio or OrcaSlicer folder, or can't be read. */
  | 'scan-failed'
  /**
   * The backup was made from another folder than the restore target. Nothing was written;
   * restore again with allowOtherSource once the user has confirmed.
   */
  | 'other-source'
  /** The backup was made from the other slicer's folder. Nothing was written. */
  | 'other-slicer'
  | 'failed';

export interface IpcError {
  code: IpcErrorCode;
  message: string;
  written?: string[];
  backupId?: string;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

/** What the UI finds as `window.presetDoctor`. */
export interface PresetDoctorApi {
  getConfig(): Promise<IpcResult<AppConfig>>;
  scan(root: string, userId?: string): Promise<IpcResult<ScanPayload>>;
  plan(choices: FixChoice[], options: PlanOptions): Promise<IpcResult<PlanPayload>>;
  apply(planId: string): Promise<IpcResult<ApplyPayload>>;
  listBackups(): Promise<IpcResult<BackupInfo[]>>;
  /**
   * Restores into `root`, the folder the UI shows (it must be one the UI scanned or picked).
   * Refuses with 'other-source' when the backup came from a different folder, unless
   * `options.allowOtherSource`.
   */
  restore(
    root: string,
    backupId: string,
    options?: RestoreOptions,
  ): Promise<IpcResult<RestorePayload>>;
  /**
   * Whether the slicer of the last scanned folder is running. The web version always answers
   * 'unknown'; the user confirms instead.
   */
  studioStatus(): Promise<IpcResult<StudioState>>;
  /** Opens a folder picker. Resolves to the folder to scan, or null when cancelled. */
  pickFolder(): Promise<IpcResult<string | null>>;
  openBackupsFolder(): Promise<IpcResult<void>>;
  openDonationPage(): Promise<IpcResult<void>>;
  /** Web only: saves a copy of a backup zip through the browser's downloads. */
  downloadBackup?(backupId: string): Promise<IpcResult<void>>;
}

/** The calls every platform implements (the desktop maps each one to an IPC channel). */
export type CoreApiCall = Exclude<keyof PresetDoctorApi, 'downloadBackup'>;
