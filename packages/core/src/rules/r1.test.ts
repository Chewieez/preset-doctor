import { describe, expect, it } from 'vitest';
import type { PresetFs } from '../fs.js';
import { scan } from '../scan.js';
import { fakeStudio, type FakeSystemPreset } from '../testing/studio.js';
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

  it('defaults to the 0.4 nozzle when the name has no suffix', async () => {
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

  it("suggests the user's own presets, without a setting id", async () => {
    const fs = fakeStudio(
      [{ name: 'Generic PLA @BBL X2D 0.4 nozzle', compatible_printers: [X2D('0.4')] }],
      [
        { name: 'My PLA @BBL X2D 0.4 nozzle', inherits: 'Generic PLA @BBL X2D 0.4 nozzle' },
        { name: 'Broken parent @BBL X2D', file: 'Orphan', inherits: 'Gone' },
        { name: 'Child', inherits: 'My PLA @BBL X2D' },
      ],
    );
    const child = (await r1(fs)).find((f) => f.presetName === 'Child');
    const cs = candidates(child);
    expect(summary(cs)).toEqual(['high* My PLA @BBL X2D 0.4 nozzle']);
    expect(cs[0]).toMatchObject({ source: 'user' });
    expect(cs[0]?.settingId).toBeUndefined();
    expect(cs[0]?.reason).toContain('one of your own presets');
    expect(child?.explanation).toContain('your own preset "My PLA @BBL X2D 0.4 nozzle"');
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
