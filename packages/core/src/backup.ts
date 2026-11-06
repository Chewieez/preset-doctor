import { unzipSync, zipSync, type Zippable } from 'fflate';
import {
  bytesEqual,
  decodeText,
  encodeText,
  errorMessage,
  isNotFound,
  joinPath,
  normalizePath,
  type PresetFs,
} from './fs.js';
import { isRecord } from './jsonFile.js';

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

/** What a manifest read back from a zip says: only the fields that passed validation. */
type ManifestInfo = Pick<Manifest, 'fileCount'> &
  Partial<Pick<Manifest, 'createdAt' | 'reason' | 'sourceRoot' | 'accounts'>>;

const REASONS: ReadonlySet<unknown> = new Set<BackupReason>([
  'before-fix',
  'before-restore',
  'manual',
]);

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

/**
 * A write was about to touch files the backup just made does not hold, so it could not be undone.
 * Nothing was written.
 */
export class BackupCoverageError extends Error {
  constructor(
    readonly missing: string[],
    readonly backupId: string,
  ) {
    super(
      `Backup ${backupId} does not include ${missing.join(', ')}, so the repair could not be ` +
        'undone and nothing was written. Is part of the user folder a link to another place? ' +
        'Move those files back into the user folder, then scan again.',
    );
    this.name = 'BackupCoverageError';
  }
}

/** The user/ files each backup made in this process holds, for assertBackupCovers. */
const backedUpFiles = new WeakMap<BackupInfo, ReadonlySet<string>>();

/** The paths in `paths` that `backup` does not hold (all of them for a backup of unknown content). */
export function missingFromBackup(backup: BackupInfo, paths: readonly string[]): string[] {
  const files = backedUpFiles.get(backup);
  return files ? paths.filter((p) => !files.has(normalizePath(p))) : [...paths];
}

/**
 * Throws BackupCoverageError unless every path is in `backup`, which must be the object
 * createBackup (or a BackupSession) returned in this process. Call it before writing, so a
 * listing that misses files (links, a future adapter) can never lead to a write with no undo.
 */
export function assertBackupCovers(backup: BackupInfo, paths: readonly string[]): void {
  const missing = missingFromBackup(backup, paths);
  if (missing.length > 0) throw new BackupCoverageError(missing, backup.id);
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
    ...new Set(
      [...files.keys(), ...dirs].map((p) => p.split('/')[1]).filter((a): a is string => !!a),
    ),
  ].sort();
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

  const info = infoFromManifest(id, path, zip.length, manifest);
  backedUpFiles.set(info, new Set(files.keys()));
  return info;
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
    let info: BackupInfo = { id, path: e.name, fileCount: 0, bytes: bytes.length };
    try {
      const manifest = readManifest(bytes);
      if (manifest) info = infoFromManifest(id, e.name, bytes.length, manifest);
      else info.fileCount = unzipEntries(bytes).files.size;
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
  /** Number of files written back (files that already matched the backup are not counted). */
  restoredCount: number;
}

/**
 * A restore stopped part-way: the `restored` files already hold the backup's contents, the rest
 * do not. `safetyBackup` holds the state from just before the restore, so restoring it undoes
 * the part that was done.
 */
export class RestoreError extends Error {
  constructor(
    readonly failedPath: string,
    readonly restored: string[],
    readonly safetyBackup: BackupInfo | null,
    cause: unknown,
  ) {
    super(
      `The restore stopped part-way at ${failedPath} (${errorMessage(cause)}). ` +
        `${restored.length} file(s) were already put back.` +
        (safetyBackup
          ? ` To go back to how it was before this restore, restore backup ${safetyBackup.id}.`
          : ''),
      { cause },
    );
    this.name = 'RestoreError';
  }
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

  let source: string | undefined;
  try {
    source = readManifest(zip)?.sourceRoot;
  } catch {
    // Unreadable manifest: the source is unknown, as for backups made before it was recorded.
  }
  if (
    options.expectedRoot !== undefined &&
    source !== undefined &&
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

  const restored: string[] = [];
  let at = USER_DIR;
  // What the file being restored held before (undefined: absent or unreadable).
  let before: Uint8Array | undefined;
  try {
    for (const d of dirs) {
      at = d;
      await srcFs.mkdir(d);
    }
    for (const [p, data] of files) {
      at = p;
      before = await tryRead(srcFs, p);
      // Files that already match are skipped: fewer writes, fewer chances to stop part-way.
      if (before && bytesEqual(before, data)) continue;
      await srcFs.writeBytes(p, data);
      restored.push(p);
    }
  } catch (err) {
    // A write can replace the file and fail afterwards (the read-back check), so count the
    // failing file as put back unless it provably still holds what it held before.
    if (files.has(at) && !(await stillHolds(srcFs, at, before))) restored.push(at);
    if (restored.length === 0) {
      throw new Error(`Could not restore ${at} (${errorMessage(err)}). No file was changed.`, {
        cause: err,
      });
    }
    throw new RestoreError(at, restored, safetyBackup, err);
  }
  return { safetyBackup, restoredCount: restored.length };
}

async function tryRead(fs: PresetFs, path: string): Promise<Uint8Array | undefined> {
  try {
    return await fs.readBytes(path);
  } catch {
    return undefined;
  }
}

/** Whether `path` provably holds `before` (or, for undefined, provably does not exist). */
async function stillHolds(
  fs: PresetFs,
  path: string,
  before: Uint8Array | undefined,
): Promise<boolean> {
  try {
    const now = await fs.readBytes(path);
    return before !== undefined && bytesEqual(now, before);
  } catch (err) {
    return before === undefined && isNotFound(err);
  }
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

/** Studio's user/ tree is about four levels deep; far deeper means a folder link loop. */
const MAX_TREE_DEPTH = 32;

async function readTree(
  fs: PresetFs,
  dir: string,
): Promise<{ files: Map<string, Uint8Array>; dirs: string[] }> {
  const files = new Map<string, Uint8Array>();
  const dirs: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    // A link that points back up the tree would otherwise recurse forever.
    if (depth > MAX_TREE_DEPTH) {
      throw new Error(
        `"${d}" is nested too deeply to back up. Is a folder in it a link to one of its parents?`,
      );
    }
    const entries = await fs.list(d);
    if (entries.length === 0) dirs.push(d);
    for (const e of entries) {
      const p = joinPath(d, e.name);
      if (e.kind === 'dir') await walk(p, depth + 1);
      else files.set(p, await fs.readBytes(p));
    }
  };
  await walk(dir, 0);
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

/**
 * The manifest of a backup zip, or null when there is none or it isn't one of ours. Fields of the
 * wrong type are left out rather than trusted. Throws only for a damaged zip or invalid JSON.
 */
function readManifest(zip: Uint8Array): ManifestInfo | null {
  const raw = unzipSync(zip, { filter: (f) => f.name === MANIFEST_NAME });
  const data = raw[MANIFEST_NAME];
  if (!data) return null;
  const m: unknown = JSON.parse(decodeText(data));
  if (!isRecord(m) || m['app'] !== 'preset-doctor' || typeof m['fileCount'] !== 'number') {
    return null;
  }
  const info: ManifestInfo = { fileCount: m['fileCount'] };
  const { createdAt, reason, sourceRoot, accounts } = m;
  if (typeof createdAt === 'string') info.createdAt = createdAt;
  if (REASONS.has(reason)) info.reason = reason as BackupReason;
  if (typeof sourceRoot === 'string') info.sourceRoot = sourceRoot;
  if (Array.isArray(accounts) && accounts.every((a) => typeof a === 'string')) {
    info.accounts = accounts;
  }
  return info;
}

function infoFromManifest(id: string, path: string, bytes: number, m: ManifestInfo): BackupInfo {
  const info: BackupInfo = { id, path, fileCount: m.fileCount, bytes };
  if (m.createdAt !== undefined) info.createdAt = m.createdAt;
  if (m.reason !== undefined) info.reason = m.reason;
  if (m.sourceRoot !== undefined) info.sourceRoot = m.sourceRoot;
  if (m.accounts !== undefined) info.accounts = m.accounts;
  return info;
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
