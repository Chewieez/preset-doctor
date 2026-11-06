import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';
import {
  FsNotFoundError,
  bytesEqual,
  decodeText,
  encodeText,
  errorMessage,
  normalizePath,
  type DirEntry,
  type PresetFs,
} from '../fs.js';

export interface NodeFsOptions {
  /** Every write/mkdir throws. Use for scanning a live folder. */
  readOnly?: boolean;
}

export interface NodeFs extends PresetFs {
  readonly root: string;
  /** Absolute OS path for a root-relative path. */
  resolve(path: string): string;
}

const RENAME_RETRIES = 5;

/** PresetFs over a real folder. Writes go to a temp file in the same folder, then rename, then verify. */
export function nodeFs(rootAbs: string, options: NodeFsOptions = {}): NodeFs {
  const root = nodePath.resolve(rootAbs);

  const resolve = (path: string): string => {
    const rel = normalizePath(path);
    return rel === '' ? root : nodePath.join(root, ...rel.split('/'));
  };
  const guardWrite = (path: string): void => {
    if (options.readOnly) throw new Error(`Read-only folder, refusing to change: ${path}`);
  };
  const wrapNotFound = async <T>(path: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new FsNotFoundError(path);
      throw err;
    }
  };

  const writeBytes = async (path: string, data: Uint8Array): Promise<void> => {
    guardWrite(path);
    // Write through a file symlink to the file it points at: renaming onto the link itself would
    // replace the link with a plain file and leave the real file (e.g. in OneDrive) unchanged.
    let target = resolve(path);
    try {
      target = await fsp.realpath(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await fsp.mkdir(nodePath.dirname(target), { recursive: true });
    const tmp = `${target}.preset-doctor-${randomBytes(4).toString('hex')}.tmp`;
    try {
      const handle = await fsp.open(tmp, 'wx');
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(tmp, target);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    const back = await fsp.readFile(target);
    if (!bytesEqual(back, data)) throw new Error(`Write verification failed: ${path}`);
  };

  return {
    root,
    resolve,
    async readText(path) {
      return wrapNotFound(path, async () => decodeText(await fsp.readFile(resolve(path))));
    },
    async readBytes(path) {
      return wrapNotFound(path, async () => new Uint8Array(await fsp.readFile(resolve(path))));
    },
    async writeText(path, data) {
      await writeBytes(path, encodeText(data));
    },
    writeBytes,
    async list(dir) {
      const entries = await wrapNotFound(dir, () =>
        fsp.readdir(resolve(dir), { withFileTypes: true }),
      );
      const out: DirEntry[] = [];
      for (const e of entries) {
        if (e.isDirectory()) out.push({ name: e.name, kind: 'dir' });
        else if (e.isFile()) out.push({ name: e.name, kind: 'file' });
        else if (e.isSymbolicLink()) {
          // Symlinks and Windows junctions (e.g. a filament folder moved to OneDrive): reading a
          // path through them works, so listing must show them too, or a backup would skip
          // files that a repair then edits.
          const kind = await linkTargetKind(nodePath.join(resolve(dir), e.name));
          if (kind) out.push({ name: e.name, kind });
        }
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async exists(path) {
      try {
        await fsp.stat(resolve(path));
        return true;
      } catch {
        return false;
      }
    },
    async mkdir(path) {
      guardWrite(path);
      await fsp.mkdir(resolve(path), { recursive: true });
    },
  };
}

/**
 * What a symlink or junction points at. A dangling link, or one to something that is neither a
 * file nor a folder, holds no preset data and is left out (null); any other failure is thrown
 * with the link named, so nothing reachable is silently skipped.
 */
async function linkTargetKind(abs: string): Promise<'file' | 'dir' | null> {
  let st;
  try {
    st = await fsp.stat(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new Error(
      `Can't follow the link ${abs} (${code ?? errorMessage(err)}). Is the folder or drive it ` +
        'points to (OneDrive, another drive) available?',
      { cause: err },
    );
  }
  return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
}

// Windows can briefly lock a file (antivirus, indexer), which makes rename fail with EPERM/EBUSY.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_RETRIES || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES'))
        throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}
