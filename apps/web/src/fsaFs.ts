/**
 * PresetFs over a folder the user picked in the browser (File System Access API).
 *
 * Writes go through createWritable(), which in Chromium writes a hidden swap file and only
 * replaces the real file when the stream closes, so a crash can't leave a half-written preset.
 * Every write is then read back and compared, because a backup or repair we can't verify is
 * worse than none.
 */
import {
  bytesEqual,
  decodeText,
  encodeText,
  FsNotFoundError,
  normalizePath,
  type DirEntry,
  type PresetFs,
} from '@preset-doctor/core';

export interface FsaFsOptions {
  /** Every write/mkdir/remove throws. Used for scanning and planning. */
  readOnly?: boolean;
}

export interface FsaFs extends PresetFs {
  remove(path: string): Promise<void>;
}

export function fsaFs(root: FileSystemDirectoryHandle, options: FsaFsOptions = {}): FsaFs {
  const guardWrite = (path: string): void => {
    if (options.readOnly) throw new Error(`Read-only folder, refusing to change: ${path}`);
  };

  /** The folder at `segments`, created on the way when `create` is set. */
  const dirAt = async (
    segments: readonly string[],
    path: string,
    create = false,
  ): Promise<FileSystemDirectoryHandle> => {
    let dir = root;
    for (const name of segments) {
      try {
        dir = await dir.getDirectoryHandle(name, { create });
      } catch (err) {
        throw mapError(err, path);
      }
    }
    return dir;
  };

  /** Parent folder and last name of a file path. */
  const split = (path: string): { segments: string[]; name: string } => {
    const rel = normalizePath(path);
    if (rel === '') throw new Error('Expected a file path, got the folder itself');
    const segments = rel.split('/');
    const name = segments.pop()!;
    return { segments, name };
  };

  const readBytes = async (path: string): Promise<Uint8Array> => {
    const { segments, name } = split(path);
    const dir = await dirAt(segments, path);
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      throw mapError(err, path);
    }
  };

  const writeBytes = async (path: string, data: Uint8Array): Promise<void> => {
    guardWrite(path);
    const { segments, name } = split(path);
    const dir = await dirAt(segments, path, true);
    let handle: FileSystemFileHandle;
    try {
      handle = await dir.getFileHandle(name, { create: true });
    } catch (err) {
      throw mapError(err, path);
    }
    const stream = await handle.createWritable();
    try {
      // A fresh copy: the stream may keep the buffer, and callers may reuse theirs.
      await stream.write(new Uint8Array(data));
      await stream.close();
    } catch (err) {
      await stream.abort().catch(() => undefined);
      throw err;
    }
    const back = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    if (!bytesEqual(back, data)) throw new Error(`Write verification failed: ${path}`);
  };

  return {
    async readText(path) {
      return decodeText(await readBytes(path));
    },
    readBytes,
    async writeText(path, data) {
      await writeBytes(path, encodeText(data));
    },
    writeBytes,
    async list(dirPath) {
      const rel = normalizePath(dirPath);
      const dir = await dirAt(rel === '' ? [] : rel.split('/'), dirPath);
      const out: DirEntry[] = [];
      for await (const entry of dir.values()) {
        out.push({ name: entry.name, kind: entry.kind === 'directory' ? 'dir' : 'file' });
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async exists(path) {
      const rel = normalizePath(path);
      if (rel === '') return true;
      const { segments, name } = split(rel);
      let dir: FileSystemDirectoryHandle;
      try {
        dir = await dirAt(segments, path);
      } catch {
        return false;
      }
      return (await kindOf(dir, name)) !== null;
    },
    async mkdir(path) {
      guardWrite(path);
      const rel = normalizePath(path);
      await dirAt(rel === '' ? [] : rel.split('/'), path, true);
    },
    async remove(path) {
      guardWrite(path);
      const rel = normalizePath(path);
      if (rel === '') throw new Error('Refusing to remove the root');
      const { segments, name } = split(rel);
      const dir = await dirAt(segments, path);
      try {
        await dir.removeEntry(name, { recursive: true });
      } catch (err) {
        throw mapError(err, path);
      }
    },
  };
}

async function kindOf(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<'file' | 'dir' | null> {
  try {
    await dir.getFileHandle(name);
    return 'file';
  } catch {
    // Not a file; maybe a folder.
  }
  try {
    await dir.getDirectoryHandle(name);
    return 'dir';
  } catch {
    return null;
  }
}

/** NotFoundError becomes core's FsNotFoundError (code ENOENT); the rest gets the path added. */
function mapError(err: unknown, path: string): Error {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'NotFoundError') return new FsNotFoundError(path);
  if (name === 'TypeMismatchError') {
    return new Error(`"${path}" is a file where a folder is expected, or the other way round`, {
      cause: err,
    });
  }
  return err instanceof Error ? err : new Error(String(err));
}
