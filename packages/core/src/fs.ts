/**
 * The only I/O surface the core uses. Adapters (node, in-memory, later others) implement it.
 *
 * Paths are '/'-joined and relative to the adapter root; '' is the root itself.
 * Writes create missing parent folders.
 */
export interface DirEntry {
  name: string;
  kind: 'file' | 'dir';
}

export interface PresetFs {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** Adapters must write safely (temp file + rename, or write + verify). */
  writeText(path: string, data: string): Promise<void>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  /** Direct children of a folder, sorted by name. Throws if the folder does not exist. */
  list(dir: string): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;
  /** Recursive; succeeds if the folder already exists. */
  mkdir(path: string): Promise<void>;
  /** Removes a file, or a folder and everything in it. */
  remove?(path: string): Promise<void>;
}

/** Error thrown by adapters for a missing path, so callers can branch on `code`. */
export class FsNotFoundError extends Error {
  readonly code = 'ENOENT';
  constructor(path: string) {
    super(`Not found: ${path === '' ? '(root)' : path}`);
    this.name = 'FsNotFoundError';
  }
}

export function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** Joins path segments with '/', dropping empty segments. */
export function joinPath(...parts: string[]): string {
  return parts
    .flatMap((p) => p.split('/'))
    .filter((s) => s !== '')
    .join('/');
}

/** Normalizes and validates a relative path; rejects anything that could escape the root. */
export function normalizePath(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const s of segments) {
    if (s === '' || s === '.') continue;
    if (s === '..') throw new Error(`Path must not contain '..': ${path}`);
    out.push(s);
  }
  if (/^[a-zA-Z]:/.test(out[0] ?? '')) throw new Error(`Path must be relative: ${path}`);
  return out.join('/');
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** File name without its last extension: 'a/b/Foo 0.4.json' -> 'Foo 0.4'. */
export function fileStem(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

const encoder = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF in the string so jsonFile can detect and preserve it.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

export function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

const strictDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

/** Thrown by decodeTextStrict for bytes that are not valid UTF-8. */
export class InvalidUtf8Error extends Error {
  constructor() {
    super('it is not valid UTF-8 text, probably saved in another encoding');
    this.name = 'InvalidUtf8Error';
  }
}

/**
 * Like decodeText, but throws InvalidUtf8Error instead of replacing bad bytes with U+FFFD.
 * Studio's JSON parser rejects such files, and editing the decoded text would rewrite the bad
 * bytes, so files that are edited are read with this.
 */
export function decodeTextStrict(bytes: Uint8Array): string {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    throw new InvalidUtf8Error();
  }
}

/** Reads a file as UTF-8 text, throwing InvalidUtf8Error when it isn't valid UTF-8. */
export async function readTextStrict(fs: PresetFs, path: string): Promise<string> {
  return decodeTextStrict(await fs.readBytes(path));
}

export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
