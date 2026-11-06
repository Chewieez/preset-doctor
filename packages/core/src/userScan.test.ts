import { describe, expect, it } from 'vitest';
import { getInfoValue, serializeInfoFile } from './infoFile.js';
import { memFs } from './memFs.js';
import { nodeFs } from './node/nodeFs.js';
import { fixtureRoot } from './testing/fixtures.js';
import { listAccounts, scanUser } from './userScan.js';

const BOM = String.fromCharCode(0xfeff);
const ACCOUNT = '1000000001';
const fixture = (name: Parameters<typeof fixtureRoot>[0]) =>
  nodeFs(fixtureRoot(name), { readOnly: true });

describe('listAccounts', () => {
  it('lists multi-account with most presets first, base/ included (F7)', async () => {
    expect(await listAccounts(fixture('multi-account'))).toEqual([
      { id: '1000000001', presetCount: 6 },
      { id: '1000000002', presetCount: 3 },
      { id: 'default', presetCount: 0 },
    ]);
  });

  it('returns [] when there is no user folder', async () => {
    expect(await listAccounts(memFs({ 'BambuStudio.conf': '{}' }))).toEqual([]);
  });

  it('ignores stray files and non-json entries', async () => {
    const fs = memFs({
      'user/notes.txt': 'x',
      'user/1/filament/A.json': '{}',
      'user/1/filament/A.info': '',
      'user/1/filament/readme.txt': '',
      'user/1/machine/M.json': '{}',
    });
    expect(await listAccounts(fs)).toEqual([{ id: '1', presetCount: 1 }]);
  });

  it('breaks ties: numeric ids before default, then by id', async () => {
    const fs = memFs({
      'user/default/filament/A.json': '{}',
      'user/2/filament/A.json': '{}',
      'user/1/filament/A.json': '{}',
    });
    expect((await listAccounts(fs)).map((a) => a.id)).toEqual(['1', '2', 'default']);
  });
});

describe('scanUser on fixtures', () => {
  it('reads healthy presets with sidecars, top-level before base/', async () => {
    const presets = await scanUser(fixture('healthy'), ACCOUNT);
    expect(presets).toHaveLength(13);
    expect(presets.filter((p) => p.isBase)).toHaveLength(3);
    expect(presets.findIndex((p) => p.isBase)).toBe(10);
    for (const p of presets) {
      expect(p.accountId).toBe(ACCOUNT);
      expect(p.parseError).toBeUndefined();
      expect(p.json?.['name']).toBeTypeOf('string');
      expect(p.format?.canonical).toBe(true);
      expect(p.info).toBeDefined();
      expect(serializeInfoFile(p.info!)).toBe(p.infoRaw);
      expect(getInfoValue(p.info!, 'user_id')).toBe(ACCOUNT);
    }
  });

  it('fills paths and stems', async () => {
    const presets = await scanUser(fixture('healthy'), ACCOUNT);
    const cope = presets.find((p) => p.fileStem === 'cope')!;
    expect(cope.path).toBe('user/1000000001/filament/cope.json');
    expect(cope.infoPath).toBe('user/1000000001/filament/cope.info');
    expect(cope.isBase).toBe(false);
    const base = presets.find((p) => p.fileStem === 'OVERTURE SILK PLA Silk @BBL X2D')!;
    expect(base.path).toBe('user/1000000001/filament/base/OVERTURE SILK PLA Silk @BBL X2D.json');
    expect(base.isBase).toBe(true);
    expect(base.json?.['inherits']).toBe('');
  });

  it('reports broken files instead of throwing (broken-r4)', async () => {
    const presets = await scanUser(fixture('broken-r4'), ACCOUNT);
    const byStem = new Map(presets.map((p) => [p.fileStem, p]));
    const truncated = byStem.get('Truncated Preset')!;
    expect(truncated.parseError).toBeTruthy();
    expect(truncated.json).toBeUndefined();
    expect(truncated.raw.length).toBeGreaterThan(0);
    expect(truncated.info).toBeDefined();

    const missingName = byStem.get('Missing Name')!;
    expect(missingName.parseError).toBeUndefined();
    expect(missingName.json?.['name']).toBeUndefined();

    const noInfo = byStem.get('Sunlu Wood PLA')!;
    expect(noInfo.info).toBeUndefined();
    expect(noInfo.infoRaw).toBeUndefined();
    expect(noInfo.infoPath).toBe('user/1000000001/filament/Sunlu Wood PLA.info');

    expect(byStem.get('test')!.format?.eol).toBe('\r\n');
  });

  it('reads the second account without sidecars', async () => {
    const presets = await scanUser(fixture('multi-account'), '1000000002');
    expect(presets).toHaveLength(3);
    expect(presets.every((p) => p.info === undefined)).toBe(true);
  });

  it('returns [] for an account without a filament folder', async () => {
    expect(await scanUser(fixture('multi-account'), 'default')).toEqual([]);
    expect(await scanUser(fixture('healthy'), 'nobody')).toEqual([]);
  });
});

describe('scanUser edge cases', () => {
  it('flags JSON that is not an object', async () => {
    const fs = memFs({ 'user/1/filament/Arr.json': '[1,2]', 'user/1/filament/Num.json': '3' });
    const presets = await scanUser(fs, '1');
    expect(presets.map((p) => p.parseError)).toEqual([
      expect.stringContaining('not a JSON object'),
      expect.stringContaining('not a JSON object'),
    ]);
    expect(presets[0]!.format).toBeDefined();
  });

  it('flags a file that is not valid UTF-8 (saved as ANSI) instead of decoding it lossily', async () => {
    // {"name": "A", "filament_notes": "215 °C"} with ° as the single ANSI byte 0xB0.
    const bytes = new TextEncoder().encode('{"name": "A", "filament_notes": "215 #C"}');
    bytes[bytes.indexOf(0x23)] = 0xb0;
    const fs = memFs({ 'user/1/filament/A.json': bytes });
    const [p] = await scanUser(fs, '1');
    expect(p!.json).toBeUndefined();
    expect(p!.parseError).toBe('it is not valid UTF-8 text, probably saved in another encoding');
  });

  it('keeps a BOM in raw and records it in format', async () => {
    const fs = memFs({ 'user/1/filament/B.json': BOM + '{\n    "name": "B"\n}' });
    const [p] = await scanUser(fs, '1');
    expect(p!.raw.startsWith(BOM)).toBe(true);
    expect(p!.format?.bom).toBe(true);
    expect(p!.json).toEqual({ name: 'B' });
  });

  it('accepts an upper-case .JSON extension', async () => {
    const fs = memFs({ 'user/1/filament/Up.JSON': '{}', 'user/1/filament/Up.info': 'a = b' });
    const [p] = await scanUser(fs, '1');
    expect(p!.fileStem).toBe('Up');
    expect(p!.infoPath).toBe('user/1/filament/Up.info');
    expect(p!.info).toBeDefined();
  });

  it('ignores folders named like presets and other subfolders', async () => {
    const fs = memFs({
      'user/1/filament/Dir.json/x.json': '{}',
      'user/1/filament/other/Y.json': '{}',
      'user/1/filament/base/Z.json': '{}',
    });
    expect((await scanUser(fs, '1')).map((p) => p.path)).toEqual(['user/1/filament/base/Z.json']);
  });

  it('rejects account ids that could escape the user folder', async () => {
    const fs = memFs();
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b']) {
      await expect(scanUser(fs, bad)).rejects.toThrow(/Invalid account id/);
    }
  });
});
