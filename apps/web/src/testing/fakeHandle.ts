/**
 * Test-only: an in-memory FileSystemDirectoryHandle with the parts of the File System Access API
 * that fsaFs uses, including Chromium's behaviour that a writable only replaces the file on
 * close(). Errors are DOMException-like objects with the same `name`s browsers use.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Node = FakeDir | FakeFile;

function domError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

export class FakeFile {
  readonly kind = 'file';
  data: Uint8Array = new Uint8Array();
  /** Test hook: corrupt what a write stores, to exercise write verification. */
  static mangleWrites = false;
  /** Test hook: number of writables currently open. */
  static openWritables = 0;

  constructor(readonly name: string) {}

  async getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number }> {
    const copy = this.data.slice();
    return { size: copy.length, arrayBuffer: async () => copy.buffer };
  }

  async createWritable(): Promise<{
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }> {
    const parts: Uint8Array[] = [];
    let done = false;
    FakeFile.openWritables++;
    const finish = (): void => {
      if (!done) FakeFile.openWritables--;
      done = true;
    };
    return {
      write: async (chunk) => {
        if (done) throw domError('InvalidStateError', 'Stream is closed');
        parts.push(chunk.slice());
      },
      close: async () => {
        if (done) throw domError('InvalidStateError', 'Stream is closed');
        const size = parts.reduce((n, p) => n + p.length, 0);
        const out = new Uint8Array(size);
        let at = 0;
        for (const p of parts) {
          out.set(p, at);
          at += p.length;
        }
        if (FakeFile.mangleWrites && out.length > 0) out[0] = out[0]! ^ 0xff;
        // Like Chromium's swap file: the real file changes only now.
        this.data = out;
        finish();
      },
      abort: async () => finish(),
    };
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }
}

export class FakeDir {
  readonly kind = 'directory';
  readonly children = new Map<string, Node>();
  /** Test hook: what queryPermission/requestPermission answer. */
  permission: PermissionState = 'granted';
  requests = 0;
  /** Test hook: child names that values() leaves out (as a listing that can't see them). */
  readonly hidden = new Set<string>();

  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<FakeDir> {
    checkName(name);
    const child = this.children.get(name);
    if (child instanceof FakeDir) return child;
    if (child) throw domError('TypeMismatchError', `${name} is a file`);
    if (!options.create) throw domError('NotFoundError', `${name} not found`);
    const dir = new FakeDir(name);
    this.children.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FakeFile> {
    checkName(name);
    const child = this.children.get(name);
    if (child instanceof FakeFile) return child;
    if (child) throw domError('TypeMismatchError', `${name} is a folder`);
    if (!options.create) throw domError('NotFoundError', `${name} not found`);
    const file = new FakeFile(name);
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    const child = this.children.get(name);
    if (!child) throw domError('NotFoundError', `${name} not found`);
    if (child instanceof FakeDir && child.children.size > 0 && !options.recursive) {
      throw domError('InvalidModificationError', `${name} is not empty`);
    }
    this.children.delete(name);
  }

  async *values(): AsyncGenerator<Node> {
    // Real handles list in no particular order; make sure callers sort.
    yield* [...this.children.values()].filter((c) => !this.hidden.has(c.name)).reverse();
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }

  async queryPermission(): Promise<PermissionState> {
    return this.permission;
  }

  async requestPermission(): Promise<PermissionState> {
    this.requests++;
    return this.permission;
  }

  /** As the real type, for code under test. */
  get handle(): FileSystemDirectoryHandle {
    return this as unknown as FileSystemDirectoryHandle;
  }

  /** Test helper: the folder at a '/'-joined path, created if needed. */
  dir(path: string): FakeDir {
    return path
      .split('/')
      .filter((s) => s !== '')
      .reduce<FakeDir>((dir, p) => {
        let next = dir.children.get(p);
        if (!next) {
          next = new FakeDir(p);
          dir.children.set(p, next);
        }
        if (!(next instanceof FakeDir)) throw new Error(`${p} is a file`);
        return next;
      }, this);
  }

  /** Test helper: puts a file at a '/'-joined path, creating folders. */
  put(path: string, data: string | Uint8Array): void {
    const parts = path.split('/').filter((s) => s !== '');
    const name = parts.pop()!;
    const dir = this.dir(parts.join('/'));
    const file = new FakeFile(name);
    file.data = typeof data === 'string' ? new TextEncoder().encode(data) : data.slice();
    dir.children.set(name, file);
  }

  /** Test helper: the node at a '/'-joined path, or undefined. */
  at(path: string): Node | undefined {
    return path
      .split('/')
      .filter((s) => s !== '')
      .reduce<Node | undefined>(
        (node, p) => (node instanceof FakeDir ? node.children.get(p) : undefined),
        this,
      );
  }

  /** Test helper: a file's text, or undefined. */
  text(path: string): string | undefined {
    const node = this.at(path);
    return node instanceof FakeFile ? new TextDecoder().decode(node.data) : undefined;
  }
}

function checkName(name: string): void {
  if (name === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new TypeError(`Invalid name: ${name}`);
  }
}

export function fakeFolder(name: string, files: Record<string, string | Uint8Array> = {}): FakeDir {
  const dir = new FakeDir(name);
  for (const [p, data] of Object.entries(files)) dir.put(p, data);
  return dir;
}

/** Copies a folder from disk (a fixture) into a fake folder, byte for byte. */
export function fakeFolderFromDisk(name: string, diskPath: string): FakeDir {
  const dir = new FakeDir(name);
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        dir.dir(childRel);
        walk(join(abs, e.name), childRel);
      } else dir.put(childRel, new Uint8Array(readFileSync(join(abs, e.name))));
    }
  };
  walk(diskPath, '');
  return dir;
}
