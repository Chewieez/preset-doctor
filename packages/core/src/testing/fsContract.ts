// Shared behaviour every PresetFs adapter must have. Test-only (excluded from the build).
import { describe, expect, it } from 'vitest';
import { isNotFound, type PresetFs } from '../fs.js';

export function describePresetFsContract(
  name: string,
  make: (initial: Record<string, string>) => Promise<PresetFs>,
): void {
  describe(`${name}: PresetFs contract`, () => {
    it('reads text and bytes', async () => {
      const fs = await make({ 'a/b.txt': 'héllo' });
      expect(await fs.readText('a/b.txt')).toBe('héllo');
      expect(Array.from(await fs.readBytes('a/b.txt'))).toEqual(
        Array.from(new TextEncoder().encode('héllo')),
      );
    });

    it('keeps a UTF-8 BOM in readText', async () => {
      const fs = await make({ 'bom.json': '﻿{}' });
      expect(await fs.readText('bom.json')).toBe('﻿{}');
    });

    it('throws a not-found error with code ENOENT', async () => {
      const fs = await make({});
      await expect(fs.readText('missing.json')).rejects.toSatisfy(isNotFound);
      await expect(fs.list('nope')).rejects.toSatisfy(isNotFound);
    });

    it('writes, overwrites and creates parent folders', async () => {
      const fs = await make({ 'x.json': 'old' });
      await fs.writeText('x.json', 'new');
      await fs.writeText('deep/er/y.json', 'y');
      await fs.writeBytes('bin/z.bin', new Uint8Array([0, 255, 1]));
      expect(await fs.readText('x.json')).toBe('new');
      expect(await fs.readText('deep/er/y.json')).toBe('y');
      expect(Array.from(await fs.readBytes('bin/z.bin'))).toEqual([0, 255, 1]);
    });

    it('lists direct children with kinds, sorted, and nothing else', async () => {
      const fs = await make({
        'r/b.json': '',
        'r/a.info': '',
        'r/sub/c.json': '',
        'other.txt': '',
      });
      expect(await fs.list('r')).toEqual([
        { name: 'a.info', kind: 'file' },
        { name: 'b.json', kind: 'file' },
        { name: 'sub', kind: 'dir' },
      ]);
      const top = await fs.list('');
      expect(top.map((e) => e.name)).toEqual(['other.txt', 'r']);
    });

    it('reports existence of files and folders', async () => {
      const fs = await make({ 'd/f.txt': '' });
      expect(await fs.exists('d')).toBe(true);
      expect(await fs.exists('d/f.txt')).toBe(true);
      expect(await fs.exists('d/g.txt')).toBe(false);
      expect(await fs.exists('')).toBe(true);
    });

    it('mkdir is recursive and idempotent', async () => {
      const fs = await make({});
      await fs.mkdir('a/b/c');
      await fs.mkdir('a/b/c');
      expect(await fs.list('a/b')).toEqual([{ name: 'c', kind: 'dir' }]);
      expect(await fs.list('a/b/c')).toEqual([]);
    });

    it('rejects paths that escape the root', async () => {
      const fs = await make({});
      await expect(fs.readText('../outside.txt')).rejects.toThrow(/\.\./);
      await expect(fs.writeText('a/../../x', 'x')).rejects.toThrow(/\.\./);
    });

    it('accepts backslashes and redundant separators', async () => {
      const fs = await make({ 'a/b.txt': 'ok' });
      expect(await fs.readText('a\\b.txt')).toBe('ok');
      expect(await fs.readText('/a//b.txt')).toBe('ok');
    });
  });
}
