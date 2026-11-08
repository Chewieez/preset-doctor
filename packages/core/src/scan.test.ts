import { describe, expect, it } from 'vitest';
import { memFs } from './memFs.js';
import { parsePresetName } from './names.js';
import { defaultPaths } from './node/studioProcess.js';
import { nodeFs } from './node/nodeFs.js';
import { R1_ID } from './rules/r1.js';
import { R2_ID } from './rules/r2r3.js';
import { R4_ID } from './rules/r4.js';
import { CLOUD_SYNC_EXPLANATION, R5_ID, scan, ScanError } from './scan.js';
import { loadSystemIndexes } from './systemIndex.js';
import { fixtureRoot, type FixtureName } from './testing/fixtures.js';
import {
  fakeStudio,
  sidecar,
  type FakeSystemPreset,
  type FakeUserPreset,
} from './testing/studio.js';
import type { Finding, PresetType, ScanResult } from './types.js';

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
  // No nozzle size in the name, and unsuffixed X2D presets are the 0.6/0.8 ones: ask, don't guess.
  'Synthetic Stripped Suffix.json': ['Bambu PLA Basic @BBL X2D', null],
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
      { id: '1000000001', presetCount: 6, byType: { filament: 6, process: 0, machine: 0 } },
      { id: '1000000002', presetCount: 3, byType: { filament: 3, process: 0, machine: 0 } },
      { id: 'default', presetCount: 0, byType: { filament: 0, process: 0, machine: 0 } },
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
    expect(f).toMatchObject({ ruleId: R5_ID, severity: 'info', presetPath: 'BambuStudio.conf' });
    expect(f?.explanation).toBe(CLOUD_SYNC_EXPLANATION);
    expect(f?.explanation).toContain('open each repaired preset in Bambu Studio and save it');
    expect((await scan(off)).findings).toEqual([]);
  });

  it('gives every summary the file stem, whatever the case of .json', async () => {
    const fs = memFs({
      'system/BBL.json': '{"filament_list": []}',
      'user/1/filament/Upper.JSON': '{ cut sho',
      'user/1/filament/Named.json': '{"name": "Named"}',
    });
    const r = await scan(fs);
    expect(r.presets.map((p) => [p.fileStem, p.name ?? null])).toEqual([
      ['Named', 'Named'],
      ['Upper', null],
    ]);
  });

  it('warns when BambuStudio.conf is unreadable, but not when it is fine or absent', async () => {
    const syncWarnings = (r: ScanResult) =>
      r.warnings.filter((w) => w.includes('cloud preset sync'));
    const truncated = await scan(fakeStudio([], [], { conf: '{"app": ' }));
    expect(syncWarnings(truncated)).toHaveLength(1);
    expect(syncWarnings(truncated)[0]).toMatch(/^BambuStudio\.conf is not valid JSON/);
    expect(truncated.findings.filter((f) => f.ruleId === R5_ID)).toEqual([]);

    const off = await scan(fakeStudio([], [], { conf: '{"app":{"sync_user_preset":false}}' }));
    expect(syncWarnings(off)).toEqual([]);
    expect(syncWarnings(await scan(fakeStudio([], [])))).toEqual([]);

    // Damaged, but the flag itself is still readable: the finding, and no extra warning.
    const halfOn = await scan(fakeStudio([], [], { conf: '{"app": {"sync_user_preset": true, ' }));
    expect(halfOn.findings.filter((f) => f.ruleId === R5_ID)).toHaveLength(1);
    expect(syncWarnings(halfOn)).toEqual([]);
  });

  it('result is plain data (survives JSON, as IPC needs)', async () => {
    const r: ScanResult = await scan(fixture('broken-r1'));
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

/**
 * types-bambu: file -> [type, status, pre-selected candidate or null, the high and medium
 * candidates as "name:confidence"], from the fixture README.
 */
const TYPES_EXPECTED: Record<string, [string, string, string | null, string[]]> = {
  'filament/My PLA.json': ['filament', 'ok', null, []],
  'process/0.20mm Standard @BBL X1C - Copy.json': ['process', 'ok', null, []],
  'process/Case Only.json': [
    'process',
    'hidden',
    '0.20mm Standard @BBL X1C',
    ['0.20mm Standard @BBL X1C:high'],
  ],
  'process/Added Suffix.json': [
    'process',
    'hidden',
    '0.20mm Standard @BBL X2D',
    ['0.20mm Standard @BBL X2D:high', '0.20mm High Quality @BBL X2D:medium'],
  ],
  'process/Old Profile Word.json': [
    'process',
    'hidden',
    null,
    ['0.20mm High Quality @BBL X2D:medium', '0.20mm Standard @BBL X2D:medium'],
  ],
  'process/Old Code.json': ['process', 'hidden', null, ['0.20mm Standard @BBL A1M:medium']],
  'process/No Candidates.json': ['process', 'hidden', null, []],
  'process/Template Parent.json': ['process', 'hidden', null, []],
  'process/Name Mismatch.json': ['process', 'info', null, []],
  'machine/Bambu Lab X1 Carbon 0.4 nozzle - Copy.json': ['machine', 'ok', null, []],
  'machine/Case Only Printer.json': [
    'machine',
    'hidden',
    null,
    ['Bambu Lab X1 Carbon 0.4 nozzle:high'],
  ],
  'machine/Old Model Name.json': [
    'machine',
    'hidden',
    null,
    ['Bambu Lab A1 mini 0.4 nozzle:medium'],
  ],
  'machine/base/My Printer 0.4 nozzle.json': ['machine', 'ok', null, []],
};

describe('scan on the process and printer fixture', () => {
  it('types-bambu: every type is checked against its own system presets', async () => {
    const r = await scan(fixture('types-bambu'));
    expect(r.slicer).toBe('bambu');
    expect(r.warnings).toEqual([]);
    expect(r.indexesRead).toEqual({ filament: true, process: true, machine: true });
    expect(r.systemIndexRead).toBe(true);
    expect(r.countsByType).toEqual({ filament: 1, process: 8, machine: 4 });
    expect(r.accounts[0]).toMatchObject({
      presetCount: 13,
      byType: { filament: 1, process: 8, machine: 4 },
    });
    const rel = (p: string) => p.slice('user/1000000001/'.length);
    const got = Object.fromEntries(
      r.presets.map((p) => {
        const f = r.findings.find((x) => x.presetPath === p.path && x.ruleId === R1_ID);
        const cs = f?.proposedFix?.kind === 'setInherits' ? f.proposedFix.candidates : [];
        const strong = cs
          .filter((c) => c.confidence !== 'low')
          .map((c) => `${c.name}:${c.confidence}`);
        return [rel(p.path), [p.type, p.status, f ? preselected(f) : null, strong]];
      }),
    );
    expect(got).toEqual(TYPES_EXPECTED);
    for (const f of r.findings) {
      expect(f.presetType).toBe(r.presets.find((p) => p.path === f.presetPath)?.type);
    }
  });

  it('types-bambu: process and printer findings read plainly', async () => {
    const r = await scan(fixture('types-bambu'));
    const find = (file: string, rule: string = R1_ID) =>
      r.findings.find((f) => f.presetPath.endsWith(file) && f.ruleId === rule);
    const template = find('/Template Parent.json');
    expect(template?.explanation).toContain(
      'This preset is based on "fdm_process_common", which is an internal template in Bambu ' +
        "Studio's system presets (version 02.08.00.06) that presets can't be based on, so " +
        'Studio hides it.',
    );
    expect(template?.proposedFix).toBeUndefined();
    expect(template?.title).toBe('Parent is a template, not a preset');
    expect(r.presets.find((p) => p.path.endsWith('/Template Parent.json'))?.reason).toBe(
      'Based on the template "fdm_process_common", not a preset',
    );
    const printer = find('/Case Only Printer.json');
    const cs = printer?.proposedFix?.kind === 'setInherits' ? printer.proposedFix.candidates : [];
    expect(cs[0]).toMatchObject({ name: 'Bambu Lab X1 Carbon 0.4 nozzle', confidence: 'high' });
    expect(cs.every((c) => !c.preselected)).toBe(true);
    expect(printer?.explanation).toContain('Preset Doctor never picks a printer for you');
    const rename = find('/Name Mismatch.json', R4_ID);
    expect(rename?.proposedFix).toMatchObject({ kind: 'renamePreset', newName: 'Name Mismatch' });
    const base = r.presets.find((p) => p.path.endsWith('/My Printer 0.4 nozzle.json'));
    expect(base?.reason).toBe('Custom printer, not based on another preset');
  });

  it('a preset type whose system index is unreadable is not checked, with a warning', async () => {
    const fs = memFs({
      'system/BBL.json': JSON.stringify({
        name: 'Bambulab',
        version: '01.02.03.04',
        filament_list: [],
        process_list: 'broken',
      }),
      'user/1000000001/process/P.json': JSON.stringify({
        from: 'User',
        inherits: 'Gone @BBL X1C',
        name: 'P',
        print_settings_id: 'P',
      }),
    });
    const r = await scan(fs);
    expect(r.indexesRead).toEqual({ filament: true, process: false, machine: true });
    expect(r.systemIndexRead).toBe(false);
    expect(r.warnings).toEqual([
      'system/BBL.json has no "process_list" list. Process presets based on system presets ' +
        "can't be checked.",
    ]);
    expect(r.findings.filter((f) => f.ruleId === R1_ID)).toEqual([]);
  });

  it('a filament based on an "@base" template is hidden, as Studio hides it', async () => {
    const fs = fakeStudio(
      [
        { name: 'Generic PLA @base', instantiation: 'false' },
        { name: 'Generic PLA @BBL X2D', inherits: 'Generic PLA @base' },
      ],
      [{ name: 'Mine', inherits: 'Generic PLA @base' }],
    );
    const r = await scan(fs);
    const f = r.findings.find((x) => x.ruleId === R1_ID);
    expect(f).toMatchObject({ status: 'hidden', presetType: 'filament' });
    expect(f?.explanation).toContain('is an internal template');
  });

  it('attaches setInherits fix when unsupported preset matches an installed printer', async () => {
    // A simulated scan where user has P1S enabled and a preset inheriting from X1C
    const r = await scan(
      fsWithConfig({
        models: [{ vendor: 'BBL', model: 'Bambu Lab P1S', nozzles: ['0.4'] }],
        userPresets: [
          {
            type: 'filament',
            path: 'user/1000000001/filament/My PLA @BBL X1C.json',
            inherits: 'Bambu PLA Basic @BBL X1C',
          },
        ],
      }),
    );
    const finding = r.findings.find(
      (f) => f.presetPath === 'user/1000000001/filament/My PLA @BBL X1C.json' && f.ruleId === R2_ID,
    );
    expect(finding).toBeDefined();
    expect(finding?.proposedFix).toBeDefined();
    expect(finding?.proposedFix?.kind).toBe('setInherits');
  });
});

function fsWithConfig(options: {
  models: Array<{ vendor: string; model: string; nozzles: string[] }>;
  userPresets: Array<{
    type?: PresetType;
    path: string;
    inherits?: string;
  }>;
  systemPresets?: FakeSystemPreset[];
}) {
  const confText = JSON.stringify({
    app: { sync_user_preset: false },
    models: options.models.map((m) => ({
      vendor: m.vendor,
      model: m.model,
      nozzle_diameter: m.nozzles.join(';'),
    })),
  });

  const defaultSystem: FakeSystemPreset[] = [
    {
      type: 'machine',
      name: 'Bambu Lab P1S 0.4 nozzle',
      extra: { printer_model: 'Bambu Lab P1S', printer_variant: '0.4' },
    },
    {
      type: 'machine',
      name: 'Bambu Lab X1 Carbon 0.4 nozzle',
      extra: { printer_model: 'Bambu Lab X1 Carbon', printer_variant: '0.4' },
    },
    {
      type: 'filament',
      name: 'Bambu PLA Basic @BBL X1C',
      compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'],
    },
    {
      type: 'filament',
      name: 'Bambu PLA Basic @BBL P1S 0.4 nozzle',
      compatible_printers: ['Bambu Lab P1S 0.4 nozzle'],
      setting_id: 'PFUS_P1S_04',
    },
  ];

  const userPresets: FakeUserPreset[] = options.userPresets.map((u) => {
    const match = /user\/[^/]+\/[^/]+\/(.+)\.json$/.exec(u.path);
    const file = match?.[1];
    const p: FakeUserPreset = {
      type: u.type ?? 'filament',
    };
    if (file !== undefined) {
      p.file = file;
      p.name = file;
    }
    if (u.inherits !== undefined) {
      p.inherits = u.inherits;
    }
    return p;
  });

  const accountMatch = /user\/([^/]+)\//.exec(options.userPresets[0]?.path ?? '');
  const account = accountMatch?.[1] ?? '1000000001';

  return fakeStudio(options.systemPresets ?? defaultSystem, userPresets, {
    account,
    conf: confText,
  });
}

// Read-only check against the real install: npm run test:live -- scan
describe.runIf(process.env['PRESET_DOCTOR_LIVE'] === '1')('live scan (read-only)', () => {
  // The 18 orphans were repaired in the in-Studio test on Nov 7, 2026 (SPEC.md section 10); the
  // broken-r1 fixture keeps them. This checks the repaired state, and the old test below runs
  // only if a folder with orphans is back.
  it('the repaired main account: nothing hidden, and the "06" presets use the fixed parents', async () => {
    const fs = nodeFs(defaultPaths().studioRoot, { readOnly: true });
    const r = await scan(fs);
    if (r.findings.some((f) => f.ruleId === R1_ID)) return;
    expect(r.presets.filter((p) => p.status === 'hidden' || p.status === 'broken')).toEqual([]);
    const petg = r.presets.find((p) => p.name === 'Anycubic Petg 06');
    expect(petg?.inherits).toBe('Generic PETG @BBL X2D');
    expect(petg?.compat?.printers).toContain('Bambu Lab X2D 0.6 nozzle');
  });

  it('finds the 18 orphans of the main account, each with a pre-selected fix', async () => {
    const fs = nodeFs(defaultPaths().studioRoot, { readOnly: true });
    const r = await scan(fs);
    const r1 = r.findings.filter((f) => f.ruleId === R1_ID);
    // Repaired since (see above).
    if (r1.length === 0) return;
    expect(r1).toHaveLength(18);
    const system = await loadSystemIndexes(fs);
    for (const f of r1) {
      const pick = f.proposedFix?.kind === 'setInherits' ? f.proposedFix.candidates : [];
      expect(pick.filter((c) => c.preselected && c.confidence === 'high')).toHaveLength(1);
      // ...and it is for the nozzle the missing parent's name says.
      const missing = parsePresetName(r.presets.find((p) => p.path === f.presetPath)!.inherits!);
      const model = await system.modelOf(missing!);
      const compat = await system.effectiveCompatiblePrinters(preselected(f)!);
      expect(missing?.nozzle).toBeDefined();
      expect(compat).toContain(`${model} ${missing?.nozzle} nozzle`);
    }
    const petg = r1.find((f) => f.presetName === 'Anycubic Petg 06');
    expect(preselected(petg!)).toBe('Generic PETG @BBL X2D');
  });
});
