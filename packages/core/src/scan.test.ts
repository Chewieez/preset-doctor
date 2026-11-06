import { describe, expect, it } from 'vitest';
import { memFs } from './memFs.js';
import { defaultPaths } from './node/studioProcess.js';
import { nodeFs } from './node/nodeFs.js';
import { R1_ID } from './rules/r1.js';
import { R4_ID } from './rules/r4.js';
import { R5_ID, scan, ScanError } from './scan.js';
import { fixtureRoot, type FixtureName } from './testing/fixtures.js';
import { fakeStudio, sidecar } from './testing/studio.js';
import type { Finding, ScanResult } from './types.js';

const fixture = (name: FixtureName) => nodeFs(fixtureRoot(name), { readOnly: true });
const file = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const preselected = (f: Finding) =>
  f.proposedFix?.kind === 'setInherits'
    ? (f.proposedFix.candidates.find((c) => c.preselected)?.name ?? null)
    : null;

/** Missing parent -> expected pre-selected candidate, from the fixture README. */
const BROKEN_R1: Record<string, [string, string | null]> = {
  'Anycubic Petg 06.json': ['Generic PETG @BBL X2D 0.6 nozzle', 'Generic PETG @BBL X2D'],
  'Anycubic Pla+ 06.json': ['Generic PLA @BBL X2D 0.6 nozzle', 'Generic PLA @BBL X2D'],
  'Bambu PLA Matte @BBL X2D 0.4 nozzle - Copy 06.json': [
    'Bambu PLA Matte @BBL X2D 0.6 nozzle',
    'Bambu PLA Matte @BBL X2D',
  ],
  'Cookie Cad Silk 06.json': ['Bambu PLA Silk @BBL X2D 0.6 nozzle', 'Bambu PLA Silk @BBL X2D'],
  'CookieCad TPU 06.json': ['Generic TPU @BBL X2D 0.6 nozzle', 'Generic TPU @BBL X2D'],
  'CookieCad TPU1 06.json': ['Generic TPU @BBL X2D 0.6 nozzle', 'Generic TPU @BBL X2D'],
  'cope 06.json': ['Bambu PLA Matte @BBL X2D 0.6 nozzle', 'Bambu PLA Matte @BBL X2D'],
  'Elegoo 95A Tpu 06.json': ['Generic TPU @BBL X2D 0.6 nozzle', 'Generic TPU @BBL X2D'],
  'Elegoo Petg Pro 06.json': ['Generic PETG @BBL X2D 0.6 nozzle', 'Generic PETG @BBL X2D'],
  'Elegoo Pla pro 06.json': ['Generic PLA @BBL X2D 0.6 nozzle', 'Generic PLA @BBL X2D'],
  'Flash Forge abs pro 06.json': ['Generic ABS @BBL X2D 0.6 nozzle', 'Generic ABS @BBL X2D'],
  'FLASHFORGE ABS ABS Pro - 0.4 nozzle 06.json': [
    'Generic ABS @BBL X2D 0.6 nozzle',
    'Generic ABS @BBL X2D',
  ],
  'Generic PLA @BBL X2D 0.4 nozzle - Copy 06.json': [
    'Generic PLA @BBL X2D 0.6 nozzle',
    'Generic PLA @BBL X2D',
  ],
  'Inland Petg 06.json': ['Generic PETG @BBL X2D 0.6 nozzle', 'Generic PETG @BBL X2D'],
  'Inland pla basic 06.json': ['Bambu PLA Matte @BBL X2D 0.6 nozzle', 'Bambu PLA Matte @BBL X2D'],
  'Overture ASA 06.json': ['Generic ASA @BBL X2D 0.6 nozzle', 'Generic ASA @BBL X2D'],
  'ProtoPast htpla 06.json': ['Generic PLA @BBL X2D 0.6 nozzle', 'Generic PLA @BBL X2D'],
  'sunlu pla+ 2.0 06.json': ['Bambu PLA Matte @BBL X2D 0.6 nozzle', 'Bambu PLA Matte @BBL X2D'],
  'Synthetic Stripped Suffix.json': [
    'Bambu PLA Basic @BBL X2D',
    'Bambu PLA Basic @BBL X2D 0.4 nozzle',
  ],
  'Synthetic Added Suffix.json': ['Bambu ABS @BBL X1C 0.4 nozzle', 'Bambu ABS @BBL X1C'],
  'Synthetic Other Printer Only.json': ['Overture PLA @BBL X2D 0.4 nozzle', null],
  'Synthetic No Candidates.json': ['Unobtainium Filament @BBL X2D 0.4 nozzle', null],
};

describe('scan on fixtures', () => {
  it('broken-r1: exactly the expected findings and pre-selections', async () => {
    const r = await scan(fixture('broken-r1'));
    expect(r.userId).toBe('1000000001');
    expect(r.systemVersion).toBe('02.08.00.06');
    expect(r.warnings).toEqual([]);

    const r1 = r.findings.filter((f) => f.ruleId === R1_ID);
    const got = Object.fromEntries(
      r1.map((f) => {
        const summary = r.presets.find((p) => p.path === f.presetPath);
        return [file(f.presetPath), [summary?.inherits, preselected(f)]];
      }),
    );
    expect(got).toEqual(BROKEN_R1);
    expect(r1.every((f) => f.severity === 'error' && f.status === 'hidden')).toBe(true);

    const r4 = r.findings.filter((f) => f.ruleId === R4_ID);
    expect(r4.map((f) => f.title)).toEqual(Array(18).fill('No sync file (.info)'));
    expect(r4.every((f) => file(f.presetPath).endsWith(' 06.json'))).toBe(true);

    expect(r.findings.filter((f) => f.ruleId === R5_ID)).toHaveLength(1);
    expect(r.findings).toHaveLength(22 + 18 + 1);
  });

  it('broken-r1: the headline case reads plainly', async () => {
    const r = await scan(fixture('broken-r1'));
    const f = r.findings.find((x) => x.presetPath.endsWith('/Anycubic Petg 06.json'));
    expect(preselected(f!)).toBe('Generic PETG @BBL X2D');
    expect(f?.explanation).toBe(
      'This preset is based on "Generic PETG @BBL X2D 0.6 nozzle", which no longer exists in ' +
        "Bambu Studio's system presets (version 02.08.00.06), so Studio hides it. The closest " +
        'match is "Generic PETG @BBL X2D", which Bambu now uses for the 0.6 mm nozzle.',
    );
    const other = r.findings.find((x) =>
      x.presetPath.endsWith('/Synthetic Other Printer Only.json'),
    );
    const cs = other?.proposedFix?.kind === 'setInherits' ? other.proposedFix.candidates : [];
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.every((c) => c.confidence === 'low' && !c.preselected)).toBe(true);
  });

  it('broken-r1: every preset gets a summary row', async () => {
    const r = await scan(fixture('broken-r1'));
    expect(r.presets).toHaveLength(24);
    const row = (f: string) => r.presets.find((p) => file(p.path) === f);
    expect(row('Anycubic Petg 06.json')).toMatchObject({
      status: 'hidden',
      reason: 'Parent "Generic PETG @BBL X2D 0.6 nozzle" is missing',
      ruleIds: [R1_ID, R4_ID],
    });
    expect(row('Synthetic User Child.json')).toMatchObject({
      status: 'ok',
      reason: 'Based on "Anycubic Petg"',
      ruleIds: [],
    });
  });

  it('healthy: no findings at all', async () => {
    const r = await scan(fixture('healthy'));
    expect(r.findings).toEqual([]);
    expect(r.presets).toHaveLength(13);
    expect(r.presets.every((p) => p.status === 'ok')).toBe(true);
    expect(r.presets.filter((p) => p.isBase).map((p) => p.reason)).toEqual(
      Array(3).fill('Custom filament, not based on another preset'),
    );
  });

  it('broken-r4: the expected findings', async () => {
    const r = await scan(fixture('broken-r4'));
    const got = r.findings.map((f) => [
      file(f.presetPath),
      f.severity,
      f.status,
      f.proposedFix?.kind === 'renamePreset' ? f.proposedFix.newName : null,
    ]);
    expect(got).toEqual([
      ['Biqu-morphlex.json', 'info', 'info', null],
      ['Elegoo Petg Pro.json', 'info', 'info', null],
      ['Elegoo Pla Galaxy.json', 'info', 'info', null],
      ['Elegoo Pla pro.json', 'info', 'info', null],
      ['Missing Name.json', 'error', 'broken', null],
      ['Sunlu Wood PLA.json', 'info', 'info', null],
      ['Truncated Preset.json', 'error', 'broken', null],
    ]);
    expect(r.findings.every((f) => f.ruleId === R4_ID)).toBe(true);
    expect(r.presets.find((p) => file(p.path) === 'Inland Petg.json')?.status).toBe('ok');
    // Named "test.json" by the user; Studio itself saved it as test.json, so nothing to fix.
    expect(r.presets.find((p) => file(p.path) === 'test.json')?.status).toBe('ok');
  });

  it('resolves parents in every installed vendor index, not just BBL', async () => {
    const fs = fakeStudio(
      [{ name: 'Generic PLA @BBL X1C', compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'] }],
      [
        { name: 'My Creality PLA', inherits: 'Creality Generic PLA', info: sidecar('x') },
        {
          file: 'Creality Generic PETG',
          name: 'Mine',
          inherits: 'Generic PLA @BBL X1C',
          info: sidecar('x'),
        },
      ],
    );
    await fs.writeText(
      'system/Creality.json',
      JSON.stringify({
        name: 'Creality',
        version: '02.03.00.10',
        filament_list: [
          { name: 'Creality Generic PLA', sub_path: 'filament/Creality Generic PLA.json' },
          { name: 'Creality Generic PETG', sub_path: 'filament/Creality Generic PETG.json' },
        ],
      }),
    );
    for (const name of ['Creality Generic PLA', 'Creality Generic PETG']) {
      await fs.writeText(
        `system/Creality/filament/${name}.json`,
        JSON.stringify({ type: 'filament', name, inherits: '', instantiation: 'true' }),
      );
    }
    // An index without its folder is not an installed vendor, and a broken one only warns.
    await fs.writeText('system/Stray.json', '{}');
    await fs.writeText('system/Acme.json', '{ broken');
    await fs.mkdir('system/Acme');

    const r = await scan(fs);
    const mine = r.presets.find((p) => p.name === 'My Creality PLA');
    expect(mine).toMatchObject({ status: 'ok', reason: 'Based on "Creality Generic PLA"' });
    expect(r.findings.filter((f) => f.ruleId === R1_ID)).toEqual([]);
    // R4 sees the other vendor's names too, so it won't rename onto one of them.
    const rename = r.findings.find((f) => f.presetName === 'Mine');
    expect(rename?.title).toBe("Name doesn't match the file name");
    expect(rename?.proposedFix).toBeUndefined();
    expect(rename?.explanation).toContain(
      'a Studio system preset is already called "Creality Generic PETG"',
    );
    expect(r.systemVersion).toBe('02.08.00.06');
    expect(r.warnings.join(' ')).toContain('system/Acme.json is not valid JSON');
    expect(r.warnings.join(' ')).not.toContain('Stray');
  });

  it('does not call presets OK when the system index is unreadable', async () => {
    const fs = fakeStudio(
      [],
      [
        { name: 'Mine', inherits: 'Gone @BBL X1C', info: sidecar('x') },
        { name: 'No sidecar', inherits: 'Gone too' },
        { name: 'Wizard', inherits: '', base: true, info: sidecar('x') },
      ],
    );
    await fs.remove('system/BBL.json');
    const r = await scan(fs);
    expect(r.systemIndexRead).toBe(false);
    expect(r.presets.map((p) => [p.name, p.status, p.reason])).toEqual([
      ['Mine', 'info', 'Parent "Gone @BBL X1C" could not be checked (system presets unreadable)'],
      ['No sidecar', 'info', 'Parent "Gone too" could not be checked (system presets unreadable)'],
      ['Wizard', 'ok', 'Custom filament, not based on another preset'],
    ]);
  });

  it('multi-account: defaults to the account with the most presets', async () => {
    const r = await scan(fixture('multi-account'));
    expect(r.accounts).toEqual([
      { id: '1000000001', presetCount: 6 },
      { id: '1000000002', presetCount: 3 },
      { id: 'default', presetCount: 0 },
    ]);
    expect(r.userId).toBe('1000000001');
    expect(r.findings).toEqual([]);

    const second = await scan(fixture('multi-account'), { userId: '1000000002' });
    expect(second.findings.filter((f) => f.ruleId === R1_ID)).toHaveLength(3);
    expect(second.presets.every((p) => p.accountId === '1000000002')).toBe(true);

    const empty = await scan(fixture('multi-account'), { userId: 'default' });
    expect(empty.presets).toEqual([]);
  });

  it('rejects an unknown account and a folder that is not a Studio folder', async () => {
    await expect(scan(fixture('multi-account'), { userId: '42' })).rejects.toThrow(
      'There is no account folder "42". Found: 1000000001, 1000000002, default.',
    );
    await expect(scan(memFs({ 'readme.txt': 'hi' }))).rejects.toBeInstanceOf(ScanError);
  });

  it('uses the adapter root, or the given label, as ScanResult.root', async () => {
    expect((await scan(fixture('healthy'))).root).toBe(fixtureRoot('healthy'));
    const fs = fakeStudio([], []);
    expect((await scan(fs, { root: 'X' })).root).toBe('X');
  });

  it('reads the cloud-sync flag from BambuStudio.conf', async () => {
    const on = fakeStudio([], [], { conf: '{"app":{"sync_user_preset":true}}\n# MD5 checksum 0' });
    const off = fakeStudio([], [], { conf: '{"app":{"sync_user_preset":false}}' });
    const [f] = (await scan(on)).findings;
    expect(f).toMatchObject({ ruleId: R5_ID, severity: 'warning', presetPath: 'BambuStudio.conf' });
    expect(f?.explanation).toBe(
      'Turn off preset sync or log out of Bambu Studio before repairing, or the cloud copy may ' +
        'undo the fix.',
    );
    expect((await scan(off)).findings).toEqual([]);
  });

  it('result is plain data (survives JSON, as IPC needs)', async () => {
    const r: ScanResult = await scan(fixture('broken-r1'));
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

// Read-only check against the real install: PRESET_DOCTOR_LIVE=1 npx vitest run scan
describe.runIf(process.env['PRESET_DOCTOR_LIVE'] === '1')('live scan (read-only)', () => {
  it('finds the 18 orphans of the main account, each with a pre-selected fix', async () => {
    const fs = nodeFs(defaultPaths().studioRoot, { readOnly: true });
    const r = await scan(fs);
    const r1 = r.findings.filter((f) => f.ruleId === R1_ID);
    expect(r1).toHaveLength(18);
    for (const f of r1) {
      const pick = f.proposedFix?.kind === 'setInherits' ? f.proposedFix.candidates : [];
      expect(pick.filter((c) => c.preselected && c.confidence === 'high')).toHaveLength(1);
    }
    const petg = r1.find((f) => f.presetName === 'Anycubic Petg 06');
    expect(preselected(petg!)).toBe('Generic PETG @BBL X2D');
  });
});
