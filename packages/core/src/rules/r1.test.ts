import { describe, expect, it } from 'vitest';
import type { PresetFs } from '../fs.js';
import { memFs } from '../memFs.js';
import { scan } from '../scan.js';
import { defaultPaths } from '../node/studioProcess.js';
import { loadSystemCopy, simulateR1 } from '../testing/r1Simulation.js';
import {
  fakeStudio,
  sidecar,
  type FakeSystemPreset,
  type FakeUserPreset,
} from '../testing/studio.js';
import type { Candidate, Finding } from '../types.js';
import { R1_ID } from './r1.js';

const X2D = (n: string) => `Bambu Lab X2D ${n} nozzle`;

const PETG: FakeSystemPreset[] = [
  {
    name: 'Generic PETG @BBL X2D',
    compatible_printers: [X2D('0.6'), X2D('0.8')],
    setting_id: 'G16',
  },
  {
    name: 'Generic PETG @BBL X2D 0.4 nozzle',
    compatible_printers: [X2D('0.4')],
    setting_id: 'G15',
  },
  {
    name: 'Generic PETG @BBL X2D 0.2 nozzle',
    compatible_printers: [X2D('0.2')],
    setting_id: 'G17',
  },
  {
    name: 'Generic PETG @BBL X1C',
    compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'],
    setting_id: 'G01',
  },
];

async function r1(fs: PresetFs): Promise<Finding[]> {
  return (await scan(fs)).findings.filter((f) => f.ruleId === R1_ID);
}

function candidates(f: Finding | undefined): Candidate[] {
  return f?.proposedFix?.kind === 'setInherits' ? f.proposedFix.candidates : [];
}

const summary = (cs: Candidate[]) =>
  cs.map((c) => `${c.confidence}${c.preselected ? '*' : ''} ${c.name}`);

describe('R1 candidate ranking', () => {
  it('picks the preset whose compatible printers include the target nozzle', async () => {
    const fs = fakeStudio(PETG, [{ name: 'Mine', inherits: 'Generic PETG @BBL X2D 0.6 nozzle' }]);
    const [f] = await r1(fs);
    expect(f).toMatchObject({ severity: 'error', status: 'hidden', presetName: 'Mine' });
    expect(summary(candidates(f))).toEqual([
      'high* Generic PETG @BBL X2D',
      'medium Generic PETG @BBL X2D 0.4 nozzle',
      'medium Generic PETG @BBL X2D 0.2 nozzle',
      'low Generic PETG @BBL X1C',
    ]);
    expect(candidates(f)[0]).toMatchObject({ settingId: 'G16', source: 'system' });
    expect(f?.explanation).toBe(
      'This preset is based on "Generic PETG @BBL X2D 0.6 nozzle", which no longer exists in ' +
        "Bambu Studio's system presets (version 02.08.00.06), so Studio hides it. The closest " +
        'match is "Generic PETG @BBL X2D", which Bambu now uses for the 0.6 mm nozzle.',
    );
  });

  it('defaults to 0.4 for a name without a size when the profile has nothing to learn from', async () => {
    // No unsuffixed X2D preset here says what such names mean; see 'R1 nozzle evidence'.
    const fs = fakeStudio(
      [
        { name: 'Foo @BBL X2D 0.4 nozzle', compatible_printers: [X2D('0.4')] },
        { name: 'Foo @BBL X2D 0.6 nozzle', compatible_printers: [X2D('0.6')] },
      ],
      [{ name: 'Mine', inherits: 'Foo @BBL X2D' }],
    );
    expect(summary(candidates((await r1(fs))[0]))[0]).toBe('high* Foo @BBL X2D 0.4 nozzle');
  });

  it("uses the orphan's own compatible_printers when the name has no nozzle", async () => {
    const fs = fakeStudio(
      [
        { name: 'Foo @BBL X2D 0.4 nozzle', compatible_printers: [X2D('0.4')] },
        { name: 'Foo @BBL X2D 0.6 nozzle', compatible_printers: [X2D('0.6')] },
      ],
      [
        {
          name: 'Mine',
          inherits: 'Foo @BBL X2D',
          extra: { compatible_printers: [X2D('0.6')] },
        },
      ],
    );
    expect(summary(candidates((await r1(fs))[0]))).toEqual([
      'high* Foo @BBL X2D 0.6 nozzle',
      'medium Foo @BBL X2D 0.4 nozzle',
    ]);
  });

  it("never pre-selects a nozzle the orphan's own compatible_printers leaves out", async () => {
    // As if Bambu renamed "Generic PETG @BBL X2D" (the 0.6/0.8 variant).
    const fs = fakeStudio(
      PETG.filter((p) => p.name !== 'Generic PETG @BBL X2D'),
      [
        {
          name: 'Mine',
          inherits: 'Generic PETG @BBL X2D',
          extra: { compatible_printers: [X2D('0.6'), X2D('0.8')] },
        },
      ],
    );
    const [f] = await r1(fs);
    expect(summary(candidates(f))).toEqual([
      'medium Generic PETG @BBL X2D 0.4 nozzle',
      'medium Generic PETG @BBL X2D 0.2 nozzle',
      'low Generic PETG @BBL X1C',
    ]);
    expect(f?.explanation).toContain('There is no exact replacement.');
  });

  it('ranks high only a candidate covering every nozzle the orphan lists', async () => {
    const fs = fakeStudio(
      [
        { name: 'Foo @BBL X2D 0.4 nozzle', compatible_printers: [X2D('0.4')] },
        { name: 'Foo @BBL X2D 0.6 nozzle', compatible_printers: [X2D('0.6'), X2D('0.8')] },
        { name: 'Foo @BBL X2D 0.8 nozzle', compatible_printers: [X2D('0.8')] },
      ],
      [
        {
          name: 'Mine',
          inherits: 'Foo @BBL X2D',
          extra: { compatible_printers: [X2D('0.6'), X2D('0.8')] },
        },
      ],
    );
    const [f] = await r1(fs);
    const cs = candidates(f);
    expect(summary(cs)).toEqual([
      'high* Foo @BBL X2D 0.6 nozzle',
      'medium Foo @BBL X2D 0.8 nozzle',
      'medium Foo @BBL X2D 0.4 nozzle',
    ]);
    expect(cs[1]?.reason).toBe('Same filament and printer, but only for the 0.8 mm nozzle.');
    expect(f?.explanation).toContain('which Bambu now uses for the 0.6 or 0.8 mm nozzle.');
  });

  it('resolves compatible_printers through the parent chain', async () => {
    const fs = fakeStudio(
      [
        { name: 'Foo @base', compatible_printers: [] },
        { name: 'Foo @BBL X2D', inherits: 'Foo @base', compatible_printers: [X2D('0.6')] },
        { name: 'Foo @BBL X2D 0.6 nozzle copy', inherits: 'Foo @BBL X2D' },
      ],
      [{ name: 'Mine', inherits: 'Foo @BBL X2D 0.6 nozzle' }],
    );
    // "Foo @BBL X2D 0.6 nozzle copy" doesn't parse as an X2D name, so only one candidate.
    expect(summary(candidates((await r1(fs))[0]))).toEqual(['high* Foo @BBL X2D']);
  });

  it('falls back to the " 0.4 nozzle" toggle when compatibility is unknown', async () => {
    const added = fakeStudio(
      [{ name: 'Bar @BBL Q1 0.4 nozzle' }, { name: 'Bar @BBL Q1 0.6 nozzle' }],
      [{ name: 'Mine', inherits: 'Bar @BBL Q1' }],
    );
    const [f] = await r1(added);
    expect(summary(candidates(f))).toEqual([
      'high* Bar @BBL Q1 0.4 nozzle',
      'medium Bar @BBL Q1 0.6 nozzle',
    ]);
    expect(candidates(f)[0]?.reason).toBe('Same name with " 0.4 nozzle" added.');
    expect(f?.explanation).toContain('looks like the same preset under its current name');

    const stripped = fakeStudio(
      [{ name: 'Bar @BBL Q1' }],
      [{ name: 'Mine', inherits: 'Bar @BBL Q1 0.4 nozzle' }],
    );
    const cs = candidates((await r1(stripped))[0]);
    expect(summary(cs)).toEqual(['high* Bar @BBL Q1']);
    expect(cs[0]?.reason).toBe('Same name with " 0.4 nozzle" removed.');
  });

  it('ranks other nozzles of the same printer as medium, nearest size first', async () => {
    const fs = fakeStudio(
      [
        { name: 'Baz @BBL X2D', compatible_printers: [X2D('0.6')] },
        { name: 'Baz @BBL X2D 0.4 nozzle', compatible_printers: [X2D('0.4')] },
        { name: 'Baz @BBL X2D 0.2 nozzle', compatible_printers: [X2D('0.2')] },
      ],
      [{ name: 'Mine', inherits: 'Baz @BBL X2D 0.8 nozzle' }],
    );
    const cs = candidates((await r1(fs))[0]);
    expect(summary(cs)).toEqual([
      'medium Baz @BBL X2D',
      'medium Baz @BBL X2D 0.4 nozzle',
      'medium Baz @BBL X2D 0.2 nozzle',
    ]);
    expect(cs[0]?.reason).toBe('Same filament and printer, but for the 0.6 mm nozzle.');
  });

  it('pre-selects nothing when several candidates are equally good', async () => {
    const fs = fakeStudio(
      [
        { name: 'Baz @BBL X2D', compatible_printers: [X2D('0.4'), X2D('0.6')] },
        { name: 'Baz @BBL X2D 0.6 nozzle', compatible_printers: [X2D('0.6')] },
      ],
      // "0.60" is the same size as "0.6", so both presets fit.
      [{ name: 'Mine', inherits: 'Baz @BBL X2D 0.60 nozzle' }],
    );
    const [f] = await r1(fs);
    expect(summary(candidates(f))).toEqual(['high Baz @BBL X2D', 'high Baz @BBL X2D 0.6 nozzle']);
    expect(f?.explanation).toContain('2 presets look like good replacements');
  });

  it('treats a capitalization-only difference as a high-confidence match', async () => {
    const fs = fakeStudio(
      [{ name: 'Generic PETG @BBL X2D', compatible_printers: [X2D('0.6')] }],
      [{ name: 'Mine', inherits: 'Generic Petg @BBL X2D' }],
    );
    const cs = candidates((await r1(fs))[0]);
    expect(summary(cs)).toEqual(['high* Generic PETG @BBL X2D']);
    expect(cs[0]?.reason).toBe('Same name, only the capitalization differs.');
  });

  it('offers only low-confidence candidates when the filament exists for other printers', async () => {
    const fs = fakeStudio(PETG, [{ name: 'Mine', inherits: 'Generic PETG @BBL H2D' }]);
    const [f] = await r1(fs);
    const cs = candidates(f);
    expect(cs.length).toBe(4);
    expect(cs.every((c) => c.confidence === 'low' && !c.preselected)).toBe(true);
    expect(f?.explanation).toContain('There is no exact replacement');
  });

  it('caps the low-confidence list at ten', async () => {
    const system: FakeSystemPreset[] = Array.from({ length: 15 }, (_, i) => ({
      name: `Many @BBL P${i}`,
      compatible_printers: [`Bambu Lab P${i} 0.4 nozzle`],
    }));
    const fs = fakeStudio(system, [{ name: 'Mine', inherits: 'Many @BBL X2D' }]);
    expect(candidates((await r1(fs))[0])).toHaveLength(10);
  });

  // Bambu's history (docs/r1-history.md): "Bambu PLA Wood @BBL P1S 0.4 nozzle" was dropped and
  // "Bambu PLA Wood @BBL X1C" lists the P1S 0.4 nozzle instead.
  const P1S = (n: string) => `Bambu Lab P1S ${n} nozzle`;
  const X1C = (n: string) => `Bambu Lab X1 Carbon ${n} nozzle`;
  const WOOD: FakeSystemPreset[] = [
    { name: 'Wood @BBL X1C', compatible_printers: [X1C('0.4'), P1S('0.4')], setting_id: 'W1' },
    { name: 'Wood @BBL X1C 0.6 nozzle', compatible_printers: [X1C('0.6')], setting_id: 'W2' },
    { name: 'Wood @BBL P1S 0.6 nozzle', compatible_printers: [P1S('0.6')], setting_id: 'W3' },
  ];

  it("pre-selects another printer's preset that lists the target printer and nozzle", async () => {
    const fs = fakeStudio(WOOD, [{ name: 'Mine', inherits: 'Wood @BBL P1S 0.4 nozzle' }]);
    const [f] = await r1(fs);
    expect(summary(candidates(f))).toEqual([
      'high* Wood @BBL X1C',
      'medium Wood @BBL P1S 0.6 nozzle',
      'low Wood @BBL X1C 0.6 nozzle',
    ]);
    expect(candidates(f)[0]?.reason).toBe(
      "Bambu's current preset for the Bambu Lab P1S with a 0.4 mm nozzle. Its name is for the " +
        'X1C, but it lists yours.',
    );
    expect(f?.explanation).toContain(
      'The closest match is "Wood @BBL X1C", which Bambu now uses for the Bambu Lab P1S with the ' +
        '0.4 mm nozzle, although its name is for another printer.',
    );
  });

  it("keeps another printer's preset low when it does not list the target nozzle", async () => {
    const fs = fakeStudio(WOOD, [{ name: 'Mine', inherits: 'Wood @BBL P1S 0.8 nozzle' }]);
    const cs = candidates((await r1(fs))[0]);
    expect(cs.filter((c) => c.confidence === 'high')).toEqual([]);
    expect(cs.some((c) => c.preselected)).toBe(false);
  });

  it("pre-selects nothing when another printer's preset and the printer's own both fit", async () => {
    const fs = fakeStudio(
      [...WOOD, { name: 'Wood @BBL P1S', compatible_printers: [P1S('0.4')], setting_id: 'W4' }],
      [{ name: 'Mine', inherits: 'Wood @BBL P1S 0.4 nozzle' }],
    );
    const cs = candidates((await r1(fs))[0]);
    expect(summary(cs).slice(0, 2)).toEqual(['high Wood @BBL P1S', 'high Wood @BBL X1C']);
  });

  it('never lets the low-candidate cap drop a preset that lists the target', async () => {
    // Fifteen other printers sort before "X1C"; the one that lists the P1S is still offered.
    const system: FakeSystemPreset[] = [
      ...Array.from({ length: 15 }, (_, i) => ({
        name: `Wood @BBL A${String(i).padStart(2, '0')}`,
        compatible_printers: [`Bambu Lab A${i} 0.4 nozzle`],
      })),
      ...WOOD,
    ];
    const fs = fakeStudio(system, [{ name: 'Mine', inherits: 'Wood @BBL P1S 0.4 nozzle' }]);
    const cs = candidates((await r1(fs))[0]);
    expect(cs[0]).toMatchObject({ name: 'Wood @BBL X1C', confidence: 'high', preselected: true });
  });

  it('reports no fix when nothing has the same filament stem', async () => {
    const fs = fakeStudio(PETG, [{ name: 'Mine', inherits: 'Unobtainium @BBL X2D 0.4 nozzle' }]);
    const [f] = await r1(fs);
    expect(f?.proposedFix).toBeUndefined();
    expect(f?.explanation).toContain('found no similar preset');
  });

  it('skips non-instantiable system presets as candidates', async () => {
    const fs = fakeStudio(
      [{ name: 'Qux @BBL X2D', compatible_printers: [X2D('0.4')], instantiation: 'false' }],
      [{ name: 'Mine', inherits: 'Qux @BBL X2D 0.4 nozzle' }],
    );
    expect(candidates((await r1(fs))[0])).toEqual([]);
  });

  it("suggests the user's own filament/base/ presets, without a setting id", async () => {
    const fs = fakeStudio(
      [{ name: 'Generic PLA @BBL X2D 0.4 nozzle', compatible_printers: [X2D('0.4')] }],
      [
        {
          name: 'My PLA @BBL X2D 0.4 nozzle',
          inherits: 'Generic PLA @BBL X2D 0.4 nozzle',
          base: true,
        },
        { name: 'Broken parent @BBL X2D', file: 'Orphan', inherits: 'Gone', base: true },
        { name: 'Child', inherits: 'My PLA @BBL X2D' },
      ],
    );
    const child = (await r1(fs)).find((f) => f.presetName === 'Child');
    const cs = candidates(child);
    expect(summary(cs)).toEqual(['high* My PLA @BBL X2D 0.4 nozzle']);
    expect(cs[0]).toMatchObject({ source: 'user' });
    expect(cs[0]?.settingId).toBeUndefined();
    // One voice: "your own preset", never "Bambu's current preset ... (one of your own presets)".
    expect(cs[0]?.reason).toBe('Your own preset for the Bambu Lab X2D with a 0.4 mm nozzle.');
    expect(child?.explanation).toContain(
      'The closest match is your own preset "My PLA @BBL X2D 0.4 nozzle", which is for the 0.4 mm nozzle.',
    );
  });

  it("words another printer's user preset as the user's own, not Bambu's", async () => {
    const fs = fakeStudio(
      [{ name: 'Wood @BBL P1S 0.6 nozzle', compatible_printers: [P1S('0.6')], setting_id: 'W3' }],
      [
        {
          name: 'Wood @BBL X1C',
          inherits: 'Wood @BBL P1S 0.6 nozzle',
          base: true,
          extra: { compatible_printers: [P1S('0.4')] },
        },
        { name: 'Mine', inherits: 'Wood @BBL P1S 0.4 nozzle' },
      ],
    );
    const f = (await r1(fs)).find((x) => x.presetName === 'Mine');
    const [top] = candidates(f);
    expect(top).toMatchObject({ name: 'Wood @BBL X1C', source: 'user', preselected: true });
    expect(top?.reason).toBe(
      'Your own preset for the Bambu Lab P1S with a 0.4 mm nozzle. Its name is for the X1C, but ' +
        'it lists yours.',
    );
    expect(f?.explanation).toContain(
      'The closest match is your own preset "Wood @BBL X1C", which is for the Bambu Lab P1S with ' +
        'the 0.4 mm nozzle, although its name is for another printer.',
    );
  });
});

describe('R1 user-preset candidates follow how Studio loads them', () => {
  // Studio loads filament/base/ first, then every top-level preset in one pass, so a top-level
  // preset's parent can only be a system or base/ preset, a base/ preset's only a system one,
  // and a user preset's name is its file name (Preset.cpp:1425, 1455, 1516, 1598@v02.09.01.70).
  const SYSTEM: FakeSystemPreset[] = [
    { name: 'Generic PLA @BBL X2D 0.4 nozzle', compatible_printers: [X2D('0.4')] },
  ];
  const parent = (extra: Partial<FakeUserPreset>): FakeUserPreset => ({
    name: 'My PLA @BBL X2D 0.4 nozzle',
    inherits: 'Generic PLA @BBL X2D 0.4 nozzle',
    ...extra,
  });
  const childCandidates = async (user: FakeUserPreset[]) =>
    summary(candidates((await r1(fakeStudio(SYSTEM, user))).find((f) => f.presetName === 'Child')));

  it('never offers a top-level preset', async () => {
    expect(
      await childCandidates([parent({}), { name: 'Child', inherits: 'My PLA @BBL X2D' }]),
    ).toEqual([]);
  });

  it('never offers a preset whose file name differs from its name', async () => {
    const user = [
      parent({ base: true, file: 'My PLA @BBL X2D 0.4 nozzle (1)' }),
      { name: 'Child', inherits: 'My PLA @BBL X2D' },
    ];
    expect(await childCandidates(user)).toEqual([]);
  });

  it('never offers a base/ preset with a user parent', async () => {
    const user = [
      { name: 'My Root', base: true },
      parent({ base: true, inherits: 'My Root' }),
      { name: 'Child', inherits: 'My PLA @BBL X2D' },
    ];
    expect(await childCandidates(user)).toEqual([]);
  });

  it('offers no user preset to an orphan in base/', async () => {
    const user = [
      parent({ base: true }),
      { name: 'Child', inherits: 'My PLA @BBL X2D', base: true },
    ];
    expect(await childCandidates(user)).toEqual([]);
  });
});

describe('R1 uses the names Studio gives system presets', () => {
  // Studio names a system preset by the "name" in its file, not by BBL.json's entry
  // (PresetBundle.cpp:6631@v02.09.01.70); in profile 02.00.00.83 the two differ.
  const files = (): Record<string, string> => ({
    'system/BBL.json': JSON.stringify({
      version: '02.00.00.83',
      filament_list: [
        { name: 'SUNLU PETG @BBL A1M', sub_path: 'filament/SUNLU PETG @BBL A1M.json' },
        {
          name: 'SUNLU PETG @BBL A1M 0.2 nozzle',
          sub_path: 'filament/SUNLU PETG @BBL A1M 0.2 nozzle.json',
        },
      ],
    }),
    'system/BBL/filament/SUNLU PETG @BBL A1M.json': JSON.stringify({
      name: 'SUNLU PETG @BBL A1M 0.4 nozzle',
      inherits: '',
      instantiation: 'true',
      setting_id: 'S04',
      compatible_printers: ['Bambu Lab A1 mini 0.4 nozzle'],
    }),
    'system/BBL/filament/SUNLU PETG @BBL A1M 0.2 nozzle.json': JSON.stringify({
      name: 'SUNLU PETG @BBL A1M 0.2 nozzle',
      inherits: '',
      instantiation: 'true',
      setting_id: 'S02',
      compatible_printers: ['Bambu Lab A1 mini 0.2 nozzle'],
    }),
  });
  const user = (inherits: string): Record<string, string> => ({
    'user/1000000001/filament/Mine.json': JSON.stringify({
      name: 'Mine',
      from: 'User',
      inherits,
      version: '2.0.0.0',
    }),
  });

  it('does not report a preset whose parent is named in the file but not in the index', async () => {
    const r = await scan(memFs({ ...files(), ...user('SUNLU PETG @BBL A1M 0.4 nozzle') }));
    expect(r.findings.filter((f) => f.ruleId === R1_ID)).toEqual([]);
    expect(r.presets[0]?.status).not.toBe('hidden');
  });

  it("reports a parent only the index names, and offers the file's name", async () => {
    const [f] = await r1(memFs({ ...files(), ...user('SUNLU PETG @BBL A1M') }));
    expect(summary(candidates(f))[0]).toBe('high* SUNLU PETG @BBL A1M 0.4 nozzle');
    expect(candidates(f)[0]).toMatchObject({ settingId: 'S04', source: 'system' });
  });
});

describe('R1 chains', () => {
  it('reports children of an orphan as hidden, without a fix of their own', async () => {
    const fs = fakeStudio(PETG, [
      { name: 'Parent', inherits: 'Generic PETG @BBL X2D 0.6 nozzle' },
      { name: 'Child', inherits: 'Parent' },
    ]);
    const findings = await r1(fs);
    expect(findings.map((f) => [f.presetName, f.severity, f.status])).toEqual([
      ['Child', 'warning', 'hidden'],
      ['Parent', 'error', 'hidden'],
    ]);
    const child = findings.find((f) => f.presetName === 'Child');
    expect(child?.proposedFix).toBeUndefined();
    expect(child?.explanation).toContain('Fixing "Parent" will bring this one back too.');
  });

  it('reports an inherits loop as broken', async () => {
    const fs = fakeStudio(PETG, [
      { name: 'A', inherits: 'B' },
      { name: 'B', inherits: 'A' },
    ]);
    const findings = await r1(fs);
    expect(findings.map((f) => [f.presetName, f.status, f.title])).toEqual([
      ['A', 'broken', 'Parent presets form a loop'],
      ['B', 'broken', 'Parent presets form a loop'],
    ]);
  });

  it('accepts wizard presets with no parent and presets whose parent exists', async () => {
    const fs = fakeStudio(PETG, [
      { name: 'Wizard @Bambu Lab X2D 0.4 nozzle', inherits: '', base: true },
      { name: 'Ok', inherits: 'Generic PETG @BBL X2D' },
      { name: 'From wizard', inherits: 'Wizard @Bambu Lab X2D 0.4 nozzle' },
    ]);
    expect(await r1(fs)).toEqual([]);
  });

  it('skips R1 entirely, with a warning, when the system index is unreadable', async () => {
    const fs = fakeStudio([], [{ name: 'Mine', inherits: 'Whatever' }]);
    await fs.writeText('system/BBL.json', '{ not json');
    const result = await scan(fs);
    expect(result.systemVersion).toBeNull();
    expect(result.findings.filter((f) => f.ruleId === R1_ID)).toEqual([]);
    expect(result.warnings.join(' ')).toContain("Missing parent presets can't be checked");
  });
});

describe('R1 nozzle evidence', () => {
  // In 02.08.00.06 every unsuffixed X2D preset is for the 0.6/0.8 nozzle.
  const X2D_PLAIN: FakeSystemPreset = {
    name: 'Other @BBL X2D',
    compatible_printers: [X2D('0.6'), X2D('0.8')],
  };
  const FOO: FakeSystemPreset[] = [
    X2D_PLAIN,
    { name: 'Foo @BBL X2D 0.4 nozzle', compatible_printers: [X2D('0.4')], setting_id: 'F04' },
    { name: 'Foo @BBL X2D 0.6 nozzle', compatible_printers: [X2D('0.6')], setting_id: 'F06' },
    { name: 'Foo @BBL X1C', compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'] },
  ];

  it('asks for the nozzle when a name without a size can mean several on that printer', async () => {
    const fs = fakeStudio(FOO, [{ name: 'Mine', inherits: 'Foo @BBL X2D' }]);
    const [f] = await r1(fs);
    const cs = candidates(f);
    expect(summary(cs)).toEqual([
      'medium Foo @BBL X2D 0.4 nozzle',
      'medium Foo @BBL X2D 0.6 nozzle',
      'low Foo @BBL X1C',
    ]);
    expect(cs[0]?.reason).toBe('Same filament and printer, for the 0.4 mm nozzle.');
    expect(f?.explanation).toBe(
      'This preset is based on "Foo @BBL X2D", which no longer exists in Bambu Studio\'s system ' +
        "presets (version 02.08.00.06), so Studio hides it. Its name doesn't include a nozzle " +
        "size, and on the Bambu Lab X2D, a name like that doesn't say which nozzle it was for " +
        "(it could be the 0.4, 0.6 or 0.8 mm nozzle), so Preset Doctor can't tell. Pick the " +
        'preset for the nozzle you print with.',
    );
  });

  it('does the same for a wizard-style name of that printer', async () => {
    const fs = fakeStudio(FOO, [{ name: 'Mine', inherits: 'Foo @Bambu Lab X2D' }]);
    const [f] = await r1(fs);
    expect(summary(candidates(f)).slice(0, 2)).toEqual([
      'medium Foo @BBL X2D 0.4 nozzle',
      'medium Foo @BBL X2D 0.6 nozzle',
    ]);
    expect(f?.explanation).toContain("doesn't say which nozzle it was for");
  });

  it('still pre-selects a preset that covers every size the name could mean', async () => {
    const fs = fakeStudio(
      [
        X2D_PLAIN,
        {
          name: 'Foo @BBL X2D 0.4 nozzle',
          compatible_printers: [X2D('0.4'), X2D('0.6'), X2D('0.8')],
        },
        { name: 'Foo @BBL X2D 0.6 nozzle', compatible_printers: [X2D('0.6')] },
      ],
      [{ name: 'Mine', inherits: 'Foo @BBL X2D' }],
    );
    const [f] = await r1(fs);
    const cs = candidates(f);
    expect(summary(cs)).toEqual([
      'high* Foo @BBL X2D 0.4 nozzle',
      'medium Foo @BBL X2D 0.6 nozzle',
    ]);
    expect(cs[0]?.reason).toBe(
      "Bambu's current preset for the Bambu Lab X2D, for every nozzle that name could mean " +
        '(0.4, 0.6 and 0.8 mm).',
    );
    expect(f?.explanation).toContain(
      'which Bambu now uses for all of the 0.4, 0.6 and 0.8 mm nozzles.',
    );
  });

  it('counts every size the printer takes, not just those of unsuffixed presets', async () => {
    // A renamed preset may have been for the 0.2 nozzle, which no unsuffixed preset covers.
    const fs = fakeStudio(
      [
        X2D_PLAIN,
        { name: 'Bar @BBL X2D 0.2 nozzle', compatible_printers: [X2D('0.2')] },
        {
          name: 'Foo @BBL X2D 0.4 nozzle',
          compatible_printers: [X2D('0.4'), X2D('0.6'), X2D('0.8')],
        },
      ],
      [{ name: 'Mine', inherits: 'Foo @BBL X2D' }],
    );
    expect(summary(candidates((await r1(fs))[0]))).toEqual(['medium Foo @BBL X2D 0.4 nozzle']);
  });

  it('follows the profile when every unsuffixed preset of the printer is for 0.4 alone', async () => {
    const Q1 = (n: string) => `Bambu Lab Q1 ${n} nozzle`;
    const fs = fakeStudio(
      [
        { name: 'Other @BBL Q1', compatible_printers: [Q1('0.4')] },
        { name: 'Foo @BBL Q1 0.4 nozzle', compatible_printers: [Q1('0.4')] },
        { name: 'Foo @BBL Q1 0.6 nozzle', compatible_printers: [Q1('0.6')] },
      ],
      [{ name: 'Mine', inherits: 'Foo @BBL Q1' }],
    );
    expect(summary(candidates((await r1(fs))[0]))).toEqual([
      'high* Foo @BBL Q1 0.4 nozzle',
      'medium Foo @BBL Q1 0.6 nozzle',
    ]);
  });

  it('does not trust the " 0.4 nozzle" toggle where plain names are for other sizes', async () => {
    // "Foo @BBL X2D" has no compatible_printers, and plain X2D names are for 0.6/0.8.
    const fs = fakeStudio(
      [X2D_PLAIN, { name: 'Foo @BBL X2D' }],
      [{ name: 'Mine', inherits: 'Foo @BBL X2D 0.4 nozzle' }],
    );
    const cs = candidates((await r1(fs))[0]);
    expect(summary(cs)).toEqual(['medium Foo @BBL X2D']);
    expect(cs[0]?.reason).toBe(
      "Same filament and printer; Preset Doctor couldn't tell which nozzle it is for.",
    );
  });

  it('pre-selects the high candidate the sidecar base_id names, among several', async () => {
    const fs = fakeStudio(
      [
        { name: 'Baz @BBL X2D', compatible_printers: [X2D('0.4'), X2D('0.6')], setting_id: 'B1' },
        { name: 'Baz @BBL X2D 0.6 nozzle', compatible_printers: [X2D('0.6')], setting_id: 'B2' },
      ],
      [{ name: 'Mine', inherits: 'Baz @BBL X2D 0.60 nozzle', info: sidecar('B2') }],
    );
    const [f] = await r1(fs);
    const cs = candidates(f);
    expect(summary(cs)).toEqual(['high Baz @BBL X2D', 'high* Baz @BBL X2D 0.6 nozzle']);
    expect(cs[1]?.reason).toBe(
      "Bambu's current preset for the Bambu Lab X2D with a 0.60 mm nozzle. Your preset's sync " +
        'file (.info) also names it.',
    );
    expect(f?.explanation).toContain(
      '2 presets look like good replacements; "Baz @BBL X2D 0.6 nozzle" is pre-selected because ' +
        "your preset's sync file (.info) names it.",
    );
  });

  it('never lets base_id alone pick the nozzle, but lists its preset first', async () => {
    const fs = fakeStudio(FOO, [{ name: 'Mine', inherits: 'Foo @BBL X2D', info: sidecar('F06') }]);
    const [f] = await r1(fs);
    const cs = candidates(f);
    expect(summary(cs).slice(0, 2)).toEqual([
      'medium Foo @BBL X2D 0.6 nozzle',
      'medium Foo @BBL X2D 0.4 nozzle',
    ]);
    expect(cs[0]?.reason).toBe(
      "Your preset's sync file (.info) says it was made from this preset, which is for the 0.6 " +
        'mm nozzle. That file is not always right, so check it matches your nozzle.',
    );
    expect(f?.explanation).toContain("doesn't say which nozzle it was for");
  });

  it('ignores a base_id that contradicts the name, or names another filament', async () => {
    // Real sidecars sometimes name the 0.4 sibling of a 0.6 preset's parent.
    const sibling = fakeStudio(PETG, [
      { name: 'Mine', inherits: 'Generic PETG @BBL X2D 0.6 nozzle', info: sidecar('G15') },
    ]);
    const cs = candidates((await r1(sibling))[0]);
    expect(summary(cs)[0]).toBe('high* Generic PETG @BBL X2D');
    expect(cs.find((c) => c.name === 'Generic PETG @BBL X2D 0.4 nozzle')?.reason).toBe(
      'Same filament and printer, but for the 0.4 mm nozzle.',
    );

    const otherStem = fakeStudio(
      [...FOO, { name: 'Generic PETG @BBL X2D 0.4 nozzle', setting_id: 'G15' }],
      [{ name: 'Mine', inherits: 'Foo @BBL X2D', info: sidecar('G15') }],
    );
    const found = candidates((await r1(otherStem))[0]);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((c) => !c.preselected && !c.reason.includes('sync file'))).toBe(true);
  });
});

// Read-only, on an in-memory copy of the real system presets:
// npm run test:live -- r1 (same numbers as `node scripts/r1-simulate.ts`).
describe.runIf(process.env['PRESET_DOCTOR_LIVE'] === '1')('live R1 simulation (read-only)', () => {
  it('never pre-selects a preset for the wrong nozzle', async () => {
    const result = await simulateR1(await loadSystemCopy(defaultPaths().studioRoot));
    expect(result.wrong).toEqual([]);
    expect(result.rows).toHaveLength(16);
    // Still repairs the real-world case: a suffixed name whose preset Bambu renamed.
    for (const row of result.rows.filter((r) => r.kind === 'renamed' && r.mode === 'suffixed')) {
      const total = Object.values(row.counts).reduce((a, b) => a + b, 0);
      expect(row.counts.correct).toBeGreaterThan(0);
      expect(row.counts.correct).toBe(total);
    }
  }, 300_000);
});
