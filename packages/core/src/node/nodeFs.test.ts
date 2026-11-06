import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertBackupCovers, createBackup } from '../backup.js';
import { describePresetFsContract } from '../testing/fsContract.js';
import { fixtureRoot } from '../testing/fixtures.js';
import { nodeFs } from './nodeFs.js';

const tempDirs: string[] = [];
function tempRoot(initial: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'preset-doctor-test-'));
  tempDirs.push(root);
  for (const [p, text] of Object.entries(initial)) {
    const abs = join(root, ...p.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  return root;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describePresetFsContract('nodeFs', async (initial) => nodeFs(tempRoot(initial)));

describe('nodeFs', () => {
  it('writes bytes exactly (CRLF, no trailing newline) and leaves no temp files', async () => {
    const root = tempRoot({ 'user/1/filament/a.json': 'old' });
    const fs = nodeFs(root);
    await fs.writeText('user/1/filament/a.json', '{\r\n    "a": "b"\r\n}');
    expect(readFileSync(join(root, 'user/1/filament/a.json'), 'utf8')).toBe(
      '{\r\n    "a": "b"\r\n}',
    );
    expect(readdirSync(join(root, 'user/1/filament'))).toEqual(['a.json']);
  });

  it('resolves root-relative paths to OS paths', () => {
    const root = tempRoot();
    expect(nodeFs(root).resolve('user/1/x.json')).toBe(join(root, 'user', '1', 'x.json'));
  });

  it('read-only mode refuses every change', async () => {
    const root = tempRoot({ 'a.txt': 'keep' });
    const fs = nodeFs(root, { readOnly: true });
    await expect(fs.writeText('a.txt', 'x')).rejects.toThrow(/Read-only/);
    await expect(fs.writeBytes('b.bin', new Uint8Array())).rejects.toThrow(/Read-only/);
    await expect(fs.mkdir('d')).rejects.toThrow(/Read-only/);
    await expect(fs.remove('a.txt')).rejects.toThrow(/Read-only/);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('keep');
    expect(await fs.readText('a.txt')).toBe('keep');
  });

  it('refuses to remove the root', async () => {
    await expect(nodeFs(tempRoot()).remove('')).rejects.toThrow(/root/);
  });

  it('lists folders behind a junction or symlink, so a backup includes them', async () => {
    // E.g. a filament folder moved to OneDrive and linked back. Junctions need no admin rights.
    const elsewhere = tempRoot({ 'Foo.json': '{"name":"Foo"}' });
    const root = tempRoot({ 'user/1000000001/thumb.bin': 'x' });
    symlinkSync(elsewhere, join(root, 'user', '1000000001', 'filament'), 'junction');
    const fs = nodeFs(root);

    expect(await fs.list('user/1000000001')).toEqual([
      { name: 'filament', kind: 'dir' },
      { name: 'thumb.bin', kind: 'file' },
    ]);
    const backup = await createBackup(fs, nodeFs(tempRoot()), { now: new Date(2026, 10, 5) });
    expect(backup.fileCount).toBe(2);
    expect(() => assertBackupCovers(backup, ['user/1000000001/filament/Foo.json'])).not.toThrow();
  });

  it('lists a file symlink as a file and leaves out a dangling one', async (ctx) => {
    const root = tempRoot({ 'd/real.json': '{}' });
    try {
      symlinkSync(join(root, 'd', 'real.json'), join(root, 'd', 'link.json'), 'file');
      symlinkSync(join(root, 'd', 'gone.json'), join(root, 'd', 'dangling.json'), 'file');
    } catch (err) {
      // Windows only allows file symlinks with Developer Mode or admin rights.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      throw err;
    }
    expect(await nodeFs(root).list('d')).toEqual([
      { name: 'link.json', kind: 'file' },
      { name: 'real.json', kind: 'file' },
    ]);
  });

  it('reads a fixture folder (read-only)', async () => {
    const fs = nodeFs(fixtureRoot('multi-account'), { readOnly: true });
    expect((await fs.list('user')).map((e) => e.name)).toEqual([
      '1000000001',
      '1000000002',
      'default',
    ]);
    expect(await fs.exists('system/BBL.json')).toBe(true);
  });
});
