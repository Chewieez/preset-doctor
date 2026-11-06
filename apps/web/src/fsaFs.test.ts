import { isNotFound } from '@preset-doctor/core';
import { afterEach, describe, expect, it } from 'vitest';
import { describePresetFsContract } from '../../../packages/core/src/testing/fsContract.js';
import { fsaFs } from './fsaFs';
import { scopedFs } from './scopedFs';
import { FakeFile, fakeFolder } from './testing/fakeHandle';

describePresetFsContract('fsaFs', async (initial) => fsaFs(fakeFolder('root', initial).handle));

describePresetFsContract('scopedFs over fsaFs', async (initial) => {
  const root = fakeFolder('root', { 'outside.txt': 'not in scope' });
  for (const [p, data] of Object.entries(initial)) root.put(`scope/${p}`, data);
  root.dir('scope');
  return scopedFs(fsaFs(root.handle), 'scope');
});

afterEach(() => {
  FakeFile.mangleWrites = false;
});

describe('fsaFs', () => {
  it('writes through createWritable and closes every stream', async () => {
    const root = fakeFolder('root', { 'a.json': 'old' });
    const fs = fsaFs(root.handle);
    await fs.writeText('a.json', 'new');
    await fs.writeText('n/e/w.json', 'x');
    expect(root.text('a.json')).toBe('new');
    expect(root.text('n/e/w.json')).toBe('x');
    expect(FakeFile.openWritables).toBe(0);
  });

  it('re-reads every write and fails when it does not match', async () => {
    const root = fakeFolder('root', { 'a.json': 'old' });
    FakeFile.mangleWrites = true;
    await expect(fsaFs(root.handle).writeText('a.json', 'new')).rejects.toThrow(
      /verification failed/,
    );
    expect(FakeFile.openWritables).toBe(0);
  });

  it('removes a new file again when its write fails, but keeps an existing one', async () => {
    const root = fakeFolder('root', { 'old.zip': 'kept' });
    const real = FakeFile.prototype.createWritable;
    FakeFile.prototype.createWritable = async function (this: FakeFile) {
      const stream = await real.call(this);
      return {
        ...stream,
        write: async () => {
          await stream.abort();
          const err = new Error('The quota has been exceeded.');
          err.name = 'QuotaExceededError';
          throw err;
        },
      };
    };
    try {
      const fs = fsaFs(root.handle);
      await expect(fs.writeBytes('backups/new.zip', new Uint8Array([1]))).rejects.toThrow(/quota/);
      await expect(fs.writeBytes('old.zip', new Uint8Array([1]))).rejects.toThrow(/quota/);
    } finally {
      FakeFile.prototype.createWritable = real;
    }
    // No 0-byte zip left behind to show up as an empty backup.
    expect(root.at('backups/new.zip')).toBeUndefined();
    expect(root.text('old.zip')).toBe('kept');
    expect(FakeFile.openWritables).toBe(0);
  });

  it('keeps the caller buffer independent of what was written', async () => {
    const root = fakeFolder('root');
    const data = new Uint8Array([1, 2, 3]);
    await fsaFs(root.handle).writeBytes('b.bin', data);
    data[0] = 9;
    expect(Array.from(await fsaFs(root.handle).readBytes('b.bin'))).toEqual([1, 2, 3]);
  });

  it('refuses every change when read-only', async () => {
    const root = fakeFolder('root', { 'a.json': 'old', 'd/x.txt': '' });
    const fs = fsaFs(root.handle, { readOnly: true });
    await expect(fs.writeText('a.json', 'new')).rejects.toThrow(/Read-only/);
    await expect(fs.mkdir('m')).rejects.toThrow(/Read-only/);
    expect(root.text('a.json')).toBe('old');
    expect(root.at('m')).toBeUndefined();
    expect(await fs.readText('a.json')).toBe('old');
  });

  it('reports not-found for missing parents and wrong kinds clearly', async () => {
    const root = fakeFolder('root', { 'file.txt': 'x' });
    const fs = fsaFs(root.handle);
    await expect(fs.readText('no/such.json')).rejects.toSatisfy(isNotFound);
    expect(await fs.exists('no/such.json')).toBe(false);
    await expect(fs.list('file.txt')).rejects.toThrow(/file where a folder/);
    await expect(fs.mkdir('file.txt')).rejects.toThrow(/file where a folder/);
  });
});

describe('scopedFs', () => {
  it('keeps paths inside its folder', async () => {
    const root = fakeFolder('root', { 'top.txt': 'top' });
    const fs = scopedFs(fsaFs(root.handle), 'backups');
    await fs.writeText('a.zip', 'z');
    expect(root.text('backups/a.zip')).toBe('z');
    await expect(fs.readText('../top.txt')).rejects.toThrow(/\.\./);
  });
});
