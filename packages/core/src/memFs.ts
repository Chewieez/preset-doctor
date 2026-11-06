import {
  FsNotFoundError,
  decodeText,
  dirname,
  encodeText,
  normalizePath,
  type DirEntry,
  type PresetFs,
} from './fs.js';

export interface MemFs extends PresetFs {
  remove(path: string): Promise<void>;
  /** Snapshot of every file as text, keyed by path. Handy for test assertions. */
  snapshot(): Record<string, string>;
}

/** In-memory PresetFs for tests and dry runs. Folders are implied by file paths. */
export function memFs(initial: Record<string, string | Uint8Array> = {}): MemFs {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['']);

  const addParents = (path: string): void => {
    for (let d = dirname(path); !dirs.has(d); d = dirname(d)) dirs.add(d);
  };
  const put = (path: string, data: Uint8Array): void => {
    const p = normalizePath(path);
    if (dirs.has(p)) throw new Error(`Is a folder: ${p}`);
    addParents(p);
    files.set(p, data.slice());
  };
  const get = (path: string): Uint8Array => {
    const p = normalizePath(path);
    const data = files.get(p);
    if (data) return data;
    // Like Node's EISDIR, so isFolderError works the same on every adapter.
    if (dirs.has(p)) throw Object.assign(new Error(`Is a folder: ${p}`), { code: 'EISDIR' });
    throw new FsNotFoundError(path);
  };

  for (const [p, v] of Object.entries(initial)) put(p, typeof v === 'string' ? encodeText(v) : v);

  return {
    async readText(path) {
      return decodeText(get(path));
    },
    async readBytes(path) {
      return get(path).slice();
    },
    async writeText(path, data) {
      put(path, encodeText(data));
    },
    async writeBytes(path, data) {
      put(path, data);
    },
    async list(dir) {
      const d = normalizePath(dir);
      if (!dirs.has(d)) throw new FsNotFoundError(dir);
      const out = new Map<string, DirEntry>();
      const consider = (p: string, kind: DirEntry['kind']): void => {
        if (p !== '' && dirname(p) === d) {
          const name = p.slice(d === '' ? 0 : d.length + 1);
          out.set(name, { name, kind });
        }
      };
      for (const p of dirs) consider(p, 'dir');
      for (const p of files.keys()) consider(p, 'file');
      return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async exists(path) {
      const p = normalizePath(path);
      return files.has(p) || dirs.has(p);
    },
    async mkdir(path) {
      const p = normalizePath(path);
      if (files.has(p)) throw new Error(`Is a file: ${p}`);
      addParents(p);
      dirs.add(p);
    },
    async remove(path) {
      const p = normalizePath(path);
      if (files.delete(p)) return;
      if (!dirs.has(p)) throw new FsNotFoundError(path);
      if (p === '') throw new Error('Refusing to remove the root');
      const prefix = `${p}/`;
      for (const f of [...files.keys()]) if (f.startsWith(prefix)) files.delete(f);
      for (const x of [...dirs]) if (x === p || x.startsWith(prefix)) dirs.delete(x);
    },
    snapshot() {
      return Object.fromEntries([...files].map(([p, b]) => [p, decodeText(b)]));
    },
  };
}
