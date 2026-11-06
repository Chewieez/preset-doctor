import { describe, expect, it } from 'vitest';
import type { PresetFs } from '../fs.js';
import { scan } from '../scan.js';
import { fakeStudio, sidecar } from '../testing/studio.js';
import type { Finding } from '../types.js';
import { R4_ID } from './r4.js';

const SYSTEM = [{ name: 'Generic PLA @BBL X2D', compatible_printers: [] }];
const INFO = sidecar('GFSL99_18');

async function r4(fs: PresetFs): Promise<Finding[]> {
  return (await scan(fs)).findings.filter((f) => f.ruleId === R4_ID);
}

const brief = (fs: Finding[]) =>
  fs.map((f) => `${f.presetName}: ${f.severity}/${f.status} ${f.title}`);

describe('R4 malformed presets', () => {
  it('reports invalid JSON and a missing name as broken', async () => {
    const fs = fakeStudio(SYSTEM, [
      { file: 'No Name', inherits: 'Generic PLA @BBL X2D', info: INFO },
    ]);
    await fs.writeText('user/1000000001/filament/Cut.json', '{ "name": "Cut", "inher');
    await fs.writeText('user/1000000001/filament/Cut.info', INFO);
    await fs.writeText('user/1000000001/filament/Array.json', '[1, 2]');
    await fs.writeText('user/1000000001/filament/Array.info', INFO);
    expect(brief(await r4(fs))).toEqual([
      'Array: error/broken File is damaged',
      'Cut: error/broken File is damaged',
      'No Name: error/broken Preset has no name',
    ]);
  });

  it('treats case-only name differences as harmless notes', async () => {
    const fs = fakeStudio(SYSTEM, [
      {
        file: 'Elegoo Pla pro',
        name: 'Elegoo PLA PRO',
        inherits: 'Generic PLA @BBL X2D',
        info: INFO,
      },
    ]);
    const [f] = await r4(fs);
    expect(f).toMatchObject({ severity: 'info', status: 'info' });
    expect(f?.proposedFix).toBeUndefined();
  });

  it('offers a rename when the name really differs from the file name', async () => {
    const fs = fakeStudio(SYSTEM, [
      { file: 'test', name: 'Old name', inherits: 'Generic PLA @BBL X2D', info: INFO },
    ]);
    const [f] = await r4(fs);
    expect(f).toMatchObject({
      severity: 'warning',
      status: 'info',
      proposedFix: { kind: 'renamePreset', newName: 'test' },
    });
    expect(f?.explanation).toContain('Renaming the preset to "test" makes them match.');
  });

  it.each([
    [
      'another preset already has the name',
      [{ file: 'Other', name: 'test', inherits: 'Generic PLA @BBL X2D', info: INFO }],
      'another of your presets is already called "test"',
    ],
    [
      'a preset is based on the old name',
      [{ name: 'Kid', inherits: 'Old name', info: INFO }],
      'your preset "Kid" is based on "Old name"',
    ],
  ])('does not offer the rename when %s', async (_why, others, reason) => {
    const fs = fakeStudio(SYSTEM, [
      { file: 'test', name: 'Old name', inherits: 'Generic PLA @BBL X2D', info: INFO },
      ...others,
    ]);
    const f = (await r4(fs)).find((x) => x.presetPath.endsWith('/test.json'));
    expect(f?.proposedFix).toBeUndefined();
    expect(f?.explanation).toContain(reason);
  });

  it('does not rename onto a system preset name', async () => {
    const fs = fakeStudio(SYSTEM, [
      { file: 'Generic PLA @BBL X2D', name: 'Mine', inherits: 'Generic PLA @BBL X2D', info: INFO },
    ]);
    const [f] = await r4(fs);
    expect(f?.proposedFix).toBeUndefined();
    expect(f?.explanation).toContain('a Studio system preset is already called');
  });

  it('notes a missing sidecar at info level', async () => {
    const fs = fakeStudio(SYSTEM, [{ name: 'Lonely', inherits: 'Generic PLA @BBL X2D' }]);
    expect(brief(await r4(fs))).toEqual(['Lonely: info/info No sync file (.info)']);
  });

  // Studio saves a preset named "test.json" as test.json, not test.json.json (path_from_name).
  it('accepts a name ending in .json, as Studio names its file', async () => {
    const fs = fakeStudio(SYSTEM, [
      { file: 'test', name: 'test.json', inherits: 'Generic PLA @BBL X2D', info: INFO },
    ]);
    expect(await r4(fs)).toEqual([]);
  });

  it('treats a .JSON ending in other capitalization as a harmless case difference', async () => {
    const fs = fakeStudio(SYSTEM, [
      { file: 'test', name: 'Test.JSON', inherits: 'Generic PLA @BBL X2D', info: INFO },
    ]);
    expect(brief(await r4(fs))).toEqual([
      'Test.JSON: info/info Name differs from the file name in capitalization only',
    ]);
  });

  it('does not rename a preset that R1 suggests as the new parent of an orphan', async () => {
    const fs = fakeStudio(
      [{ name: 'Generic PLA @BBL X1C', compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'] }],
      [
        {
          file: 'My PLA @BBL X1C (2)',
          name: 'My PLA @BBL X1C',
          inherits: 'Generic PLA @BBL X1C',
          info: INFO,
        },
        { name: 'Child', inherits: 'My PLA @BBL X1C 0.4 nozzle', info: INFO },
      ],
    );
    const f = (await r4(fs)).find((x) => x.presetName === 'My PLA @BBL X1C');
    expect(f).toMatchObject({ severity: 'warning', title: "Name doesn't match the file name" });
    expect(f?.proposedFix).toBeUndefined();
    expect(f?.explanation).toContain('it is a suggested new parent for your preset "Child"');
  });
});
