import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
