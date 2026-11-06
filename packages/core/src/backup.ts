import { unzipSync, zipSync, type Zippable } from 'fflate';
import {
  bytesEqual,
  decodeText,
  encodeText,
  isNotFound,
  joinPath,
  normalizePath,
  type PresetFs,
} from './fs.js';

/**
 * Backups of the whole `user/` folder as one zip per backup, stored in a separate backups folder.
 *
 * `srcFs` is rooted at the Bambu Studio folder (the one that contains `user/` and `system/`).
 * `destFs` is rooted at the backups folder. Zip entries keep their `user/...` paths, so a
 * backup can also be unzipped by hand straight into the Bambu Studio folder.
 */

const USER_DIR = 'user';
/** Extra entry at the zip root describing the backup. Never restored. */
export const MANIFEST_NAME = 'preset-doctor-backup.json';

export type BackupReason = 'before-fix' | 'before-restore' | 'manual';

export interface BackupInfo {
  /** File name without `.zip`, e.g. `2026-11-05T17-30-00` (a `-2` suffix if that second is taken). */
  id: string;
  /** Path of the zip inside the backups folder. */
  path: string;
  /** Number of files from `user/` in the zip (folders and the manifest not counted). */
  fileCount: number;
  /** Size of the zip in bytes. */
  bytes: number;
  /** ISO time the backup was made, when known. */
  createdAt?: string;
  reason?: BackupReason;
  /** The Bambu Studio folder the backup was taken from, as the app named it. Unknown when absent. */
  sourceRoot?: string;
  /** Account folders under user/ in the backup. */
  accounts?: string[];
}

export interface BackupOptions {
  now?: Date;
  reason?: BackupReason;
  /** Recorded in the manifest so a restore can check it goes back where it came from. */
  sourceRoot?: string;
}

interface Manifest {
  app: 'preset-doctor';
  formatVersion: 1;
  createdAt: string;
  reason: BackupReason;
  fileCount: number;
  sourceRoot?: string;
  accounts?: string[];
}

/** A restore would put a backup into a different folder than the one it was taken from. */
export class BackupSourceError extends Error {
  constructor(
    readonly sourceRoot: string,
    readonly targetRoot: string,
  ) {
    super(
      `This backup was made from ${sourceRoot}, not from ${targetRoot}. Restoring it here would ` +
        "mix another folder's presets into this one, so nothing was changed.",
    );
    this.name = 'BackupSourceError';
  }
}

/**
 * Whether two folder names denote the same folder: slashes, a trailing separator and letter case
 * are ignored (Windows paths ignore case; on other systems this errs toward "same").
 */
export function sameBackupRoot(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

const ID_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:-(\d+))?$/;

/** Local-time timestamp that is safe in file names on every OS: `2026-11-05T17-30-00`. */
export function formatBackupTimestamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

export function isBackupId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** Zips the whole `user/` tree into `<timestamp>.zip`, then re-reads and checks every file. */
export async function createBackup(
  srcFs: PresetFs,
  destFs: PresetFs,
  options: BackupOptions = {},
): Promise<BackupInfo> {
  const now = options.now ?? new Date();
  const reason = options.reason ?? 'before-fix';
  if (!(await srcFs.exists(USER_DIR))) {
    throw new Error(`There is no "${USER_DIR}" folder to back up in this Bambu Studio folder.`);
  }

  const { files, dirs } = await readTree(srcFs, USER_DIR);
  const accounts = [
    ...new Set([...files.keys(), ...dirs].map((p) => p.split('/')[1]).filter((a) => a)),
  ].sort() as string[];
  const manifest: Manifest = {
    app: 'preset-doctor',
    formatVersion: 1,
    createdAt: now.toISOString(),
    reason,
    fileCount: files.size,
    ...(options.sourceRoot !== undefined ? { sourceRoot: options.sourceRoot } : {}),
    accounts,
  };

  const zippable: Zippable = {};
  // Empty folders get their own entry so restore can recreate them; others are implied by files.
  for (const d of dirs) zippable[d] = {};
  for (const [p, data] of files) zippable[p] = data;
  zippable[MANIFEST_NAME] = encodeText(JSON.stringify(manifest, null, 2));
  const zip = zipSync(zippable, { level: 6, mtime: now });

  await destFs.mkdir('');
  const id = await freeId(destFs, formatBackupTimestamp(now));
  const path = `${id}.zip`;
  await destFs.writeBytes(path, zip);

  // A backup we cannot read back is worse than none, because it gives false confidence.
  const check = unzipEntries(await destFs.readBytes(path));
  for (const [p, data] of files) {
    const back = check.files.get(p);
    if (!back || !bytesEqual(back, data)) {
      throw new Error(`Backup check failed: "${p}" in ${path} does not match the original.`);
    }
  }
  if (check.files.size !== files.size) {
    throw new Error(`Backup check failed: ${path} has an unexpected number of files.`);
  }

  return {
    id,
    path,
    fileCount: files.size,
    bytes: zip.length,
    createdAt: manifest.createdAt,
    reason,
    ...(manifest.sourceRoot !== undefined ? { sourceRoot: manifest.sourceRoot } : {}),
    accounts,
  };
}

/** Every backup in the backups folder, newest first. A missing backups folder means none. */
export async function listBackups(destFs: PresetFs): Promise<BackupInfo[]> {
  let entries;
  try {
    entries = await destFs.list('');
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const out: BackupInfo[] = [];
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.zip')) continue;
    const id = e.name.slice(0, -'.zip'.length);
    if (!isBackupId(id)) continue;
    const bytes = await destFs.readBytes(e.name);
    const info: BackupInfo = { id, path: e.name, fileCount: 0, bytes: bytes.length };
    try {
      const manifest = readManifest(bytes);
      if (manifest) {
        info.fileCount = manifest.fileCount;
        info.createdAt = manifest.createdAt;
        info.reason = manifest.reason;
        if (typeof manifest.sourceRoot === 'string') info.sourceRoot = manifest.sourceRoot;
        if (Array.isArray(manifest.accounts)) info.accounts = manifest.accounts;
      } else {
        info.fileCount = unzipEntries(bytes).files.size;
      }
    } catch {
      // Damaged zip: still listed so the user can see it, with a file count of 0.
    }
    out.push(info);
  }
  // Ids are local time, which repeats an hour when daylight saving ends; the manifest's UTC
  // time decides when both backups have one.
  return out.sort((a, b) => utcOrder(a, b) || compareIds(b.id, a.id));
}

/** Newest first by manifest time; 0 when either is unknown or they are the same instant. */
function utcOrder(a: BackupInfo, b: BackupInfo): number {
  const ta = a.createdAt === undefined ? NaN : Date.parse(a.createdAt);
  const tb = b.createdAt === undefined ? NaN : Date.parse(b.createdAt);
  return Number.isNaN(ta) || Number.isNaN(tb) ? 0 : tb - ta;
}

export interface RestoreOptions {
  now?: Date;
  /**
   * The folder being restored into, named as at backup time. When the backup records a
   * different sourceRoot, the restore throws BackupSourceError (unless allowOtherSource).
   * Also recorded as the safety backup's sourceRoot.
   */
  expectedRoot?: string;
  /** Restore even when the backup came from another folder. */
  allowOtherSource?: boolean;
}

export interface RestoreResult {
  /** Backup of the state just before the restore, so the restore itself can be undone. */
  safetyBackup: BackupInfo | null;
  /** Number of files written back. */
  restoredCount: number;
}

/**
 * Writes every file from a backup back over `user/`.
 *
 * Files that exist now but were not in the backup are left alone, on purpose: Preset Doctor only
 * ever edits existing files, so overwriting is enough to undo its repairs, and never deleting
 * means a restore cannot destroy a preset the user created after the backup. The safety backup
 * taken first covers everything that gets overwritten.
 */
export async function restoreBackup(
  srcFs: PresetFs,
  destFs: PresetFs,
  id: string,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  if (!isBackupId(id)) throw new Error(`Not a backup name: ${id}`);
  const path = `${id}.zip`;
  let zip: Uint8Array;
  try {
    zip = await destFs.readBytes(path);
  } catch (err) {
    if (isNotFound(err)) throw new Error(`Backup "${id}" was not found.`, { cause: err });
    throw err;
  }
  // Unzip fully before touching anything, so a damaged zip fails without a half-done restore.
  const { files, dirs } = unzipEntries(zip);

  let source: unknown;
  try {
    source = readManifest(zip)?.sourceRoot;
  } catch {
    // Unreadable manifest: the source is unknown, as for backups made before it was recorded.
  }
  if (
    options.expectedRoot !== undefined &&
    typeof source === 'string' &&
    !options.allowOtherSource &&
    !sameBackupRoot(source, options.expectedRoot)
  ) {
    throw new BackupSourceError(source, options.expectedRoot);
  }

  const safetyBackup = (await srcFs.exists(USER_DIR))
    ? await createBackup(srcFs, destFs, {
        reason: 'before-restore',
        ...(options.now ? { now: options.now } : {}),
        ...(options.expectedRoot !== undefined ? { sourceRoot: options.expectedRoot } : {}),
      })
    : null;

  for (const d of dirs) await srcFs.mkdir(d);
  for (const [p, data] of files) await srcFs.writeBytes(p, data);
  return { safetyBackup, restoredCount: files.size };
}

/** Makes at most one backup per session, the first time something is about to be written. */
export class BackupSession {
  private pending: Promise<BackupInfo> | null = null;
  private done: BackupInfo | null = null;

  constructor(
    private readonly srcFs: PresetFs,
    private readonly destFs: PresetFs,
    private readonly options: BackupOptions = {},
  ) {}

  /** The backup made in this session, if any. */
  get backup(): BackupInfo | null {
    return this.done;
  }

  ensureBackupOnce(): Promise<BackupInfo> {
    if (!this.pending) {
      this.pending = createBackup(this.srcFs, this.destFs, this.options).then(
        (info) => (this.done = info),
        (err: unknown) => {
          // Let the next attempt try again instead of caching the failure.
          this.pending = null;
          throw err;
        },
      );
    }
    return this.pending;
  }
}

async function readTree(
  fs: PresetFs,
  dir: string,
): Promise<{ files: Map<string, Uint8Array>; dirs: string[] }> {
  const files = new Map<string, Uint8Array>();
  const dirs: string[] = [];
  const walk = async (d: string): Promise<void> => {
    const entries = await fs.list(d);
    if (entries.length === 0) dirs.push(d);
    for (const e of entries) {
      const p = joinPath(d, e.name);
      if (e.kind === 'dir') await walk(p);
      else files.set(p, await fs.readBytes(p));
    }
  };
  await walk(dir);
  return { files, dirs };
}

/** Unzips a backup, keeping only safe paths under `user/`. */
function unzipEntries(zip: Uint8Array): { files: Map<string, Uint8Array>; dirs: string[] } {
  const raw = unzipSync(zip);
  const files = new Map<string, Uint8Array>();
  const dirs: string[] = [];
  for (const [name, data] of Object.entries(raw)) {
    if (name === MANIFEST_NAME) continue;
    let p: string;
    try {
      p = normalizePath(name);
    } catch (err) {
      throw new Error(`Backup contains an unsafe path: ${name}`, { cause: err });
    }
    if (p !== USER_DIR && !p.startsWith(`${USER_DIR}/`)) {
      throw new Error(`Backup contains a file outside "${USER_DIR}": ${name}`);
    }
    if (name.endsWith('/')) dirs.push(p);
    else files.set(p, data);
  }
  return { files, dirs };
}

function readManifest(zip: Uint8Array): Manifest | null {
  const raw = unzipSync(zip, { filter: (f) => f.name === MANIFEST_NAME });
  const data = raw[MANIFEST_NAME];
  if (!data) return null;
  const m = JSON.parse(decodeText(data)) as Partial<Manifest>;
  if (m.app !== 'preset-doctor' || typeof m.fileCount !== 'number') return null;
  return m as Manifest;
}

async function freeId(destFs: PresetFs, base: string): Promise<string> {
  if (!(await destFs.exists(`${base}.zip`))) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!(await destFs.exists(`${id}.zip`))) return id;
  }
}

function compareIds(a: string, b: string): number {
  const ma = ID_PATTERN.exec(a);
  const mb = ID_PATTERN.exec(b);
  const ta = ma?.[1] ?? '';
  const tb = mb?.[1] ?? '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return Number(ma?.[2] ?? 1) - Number(mb?.[2] ?? 1);
}
