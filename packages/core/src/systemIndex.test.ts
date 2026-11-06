import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PresetFs } from './fs.js';
import { memFs } from './memFs.js';
import { nodeFs } from './node/nodeFs.js';
import { SystemIndexError, loadSystemIndex } from './systemIndex.js';
import { FIXTURE_NAMES, fixtureRoot } from './testing/fixtures.js';

const BOM = String.fromCharCode(0xfeff);

const fixtureFs = (name: (typeof FIXTURE_NAMES)[number]) =>
  nodeFs(fixtureRoot(name), { readOnly: true });

/** Wraps a PresetFs and records every path read, to check that loading stays lazy. */
function countingFs(inner: PresetFs): PresetFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    ...inner,
    reads,
    readText: (p) => {
      reads.push(p);
      return inner.readText(p);
    },
  };
}

function bbl(list: { name: string; sub_path: string }[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: 'Bambulab',
    version: '01.02.03.04',
    filament_list: list,
    ...extra,
  });
}

function preset(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: 'filament', from: 'system', ...fields }, null, 4);
}

describe('loadSystemIndex on fixtures', () => {
  it.each(FIXTURE_NAMES)('%s: loads every entry without warnings', async (fixture) => {
    const index = await loadSystemIndex(fixtureFs(fixture));
    expect(index.version).toBe('02.08.00.06');
    expect(index.indexPath).toBe('system/BBL.json');
    expect(index.entries.size).toBe(111);
    expect(index.missing).toEqual([]);
    const all = await index.loadAll();
    expect(all).toHaveLength(111);
    expect(index.warnings).toEqual([]);
  });

  it('knows names from the index alone, without reading preset files', async () => {
    const fs = countingFs(fixtureFs('healthy'));
    const index = await loadSystemIndex(fs);
    expect(index.has('Generic PETG @BBL X2D')).toBe(true);
    expect(index.has('Generic PETG @BBL X2D 0.4 nozzle')).toBe(true);
    // The real orphans' parent name does not exist in this profile version.
    expect(index.has('Generic PETG @BBL X2D 0.6 nozzle')).toBe(false);
    expect(index.get('Generic PETG @BBL X2D')).toEqual({
      name: 'Generic PETG @BBL X2D',
      subPath: 'filament/Generic PETG @BBL X2D.json',
      path: 'system/BBL/filament/Generic PETG @BBL X2D.json',
    });
    expect(fs.reads).toEqual(['system/BBL.json']);
  });

  it('reads only the inherit chain when one body is needed, and caches it', async () => {
    const fs = countingFs(fixtureFs('healthy'));
    const index = await loadSystemIndex(fs);
    await index.effectiveCompatiblePrinters('Generic PETG @BBL X2D');
    await index.effectiveCompatiblePrinters('Generic PETG @BBL X2D');
    expect(fs.reads).toEqual(['system/BBL.json', 'system/BBL/filament/Generic PETG @BBL X2D.json']);
  });

  it('loads preset bodies', async () => {
    const index = await loadSystemIndex(fixtureFs('healthy'));
    const unsuffixed = await index.load('Generic PETG @BBL X2D');
    expect(unsuffixed).toMatchObject({
      name: 'Generic PETG @BBL X2D',
      type: 'filament',
      settingId: 'GFSG99_16',
      inherits: 'Generic PETG @base',
      instantiation: true,
    });
    expect((await index.load('Generic PETG @BBL X2D 0.4 nozzle'))?.settingId).toBe('GFSG99_15');
    const template = await index.load('fdm_filament_common');
    expect(template?.instantiation).toBe(false);
    expect(template?.inherits).toBe('');
    expect(await index.load('Not A Preset')).toBeNull();
  });

  it('resolves compatible_printers through the inherit chain', async () => {
    const index = await loadSystemIndex(fixtureFs('healthy'));
    // In this profile the unsuffixed X2D name is the 0.6/0.8 variant.
    expect(await index.effectiveCompatiblePrinters('Generic PETG @BBL X2D')).toEqual([
      'Bambu Lab X2D 0.6 nozzle',
      'Bambu Lab X2D 0.8 nozzle',
    ]);
    expect(await index.effectiveCompatiblePrinters('Generic PETG @BBL X2D 0.4 nozzle')).toEqual([
      'Bambu Lab X2D 0.4 nozzle',
    ]);
    // @base and templates fall through to fdm_filament_common, which sets [].
    expect(await index.effectiveCompatiblePrinters('Generic PETG @base')).toEqual([]);
    expect(await index.effectiveCompatiblePrinters('Missing')).toBeNull();
  });

  it('walks the chain to the root template', async () => {
    const index = await loadSystemIndex(fixtureFs('healthy'));
    const chain = (await index.chain('Generic PETG @BBL X2D')).map((p) => p.name);
    expect(chain[0]).toBe('Generic PETG @BBL X2D');
    expect(chain).toContain('Generic PETG @base');
    expect(chain.at(-1)).toBe('fdm_filament_common');
  });

  it('finds siblings by stem, case-insensitively, skipping @base', async () => {
    const index = await loadSystemIndex(fixtureFs('healthy'));
    const names = index.namesWithStem('generic petg');
    expect(names).toEqual(
      expect.arrayContaining([
        'Generic PETG @BBL X2D',
        'Generic PETG @BBL X2D 0.2 nozzle',
        'Generic PETG @BBL X2D 0.4 nozzle',
        'Generic PETG @BBL H2D',
      ]),
    );
    expect(names).not.toContain('Generic PETG @base');
    expect(names).not.toContain('Generic PETG-CF @BBL X2D');
    expect(index.namesWithStem('Unobtainium Filament')).toEqual([]);
    expect(index.parsed('Generic PETG @BBL X2D 0.4 nozzle')).toEqual({
      stem: 'Generic PETG',
      vendorTag: 'BBL',
      printerCode: 'X2D',
      nozzle: '0.4',
    });
  });

  it('derives printer models from the data', async () => {
    const index = await loadSystemIndex(fixtureFs('healthy'));
    expect(await index.printerModel('BBL', 'X2D')).toBe('Bambu Lab X2D');
    // X1C presets also list X1, P1S and X1E; the abbreviation picks the right one.
    expect(await index.printerModel('BBL', 'X1C')).toBe('Bambu Lab X1 Carbon');
    expect(await index.printerModel('BBL', 'H2D')).toBe('Bambu Lab H2D');
    expect(await index.printerModel('BBL', 'ZZZ')).toBeNull();
    expect(Object.fromEntries(await index.printerModelMap())).toEqual({
      'BBL H2D': 'Bambu Lab H2D',
      'BBL X1C': 'Bambu Lab X1 Carbon',
      'BBL X2D': 'Bambu Lab X2D',
    });
  });

  it('resolves models for parsed names', async () => {
    const index = await loadSystemIndex(fixtureFs('healthy'));
    expect(await index.modelOf({ stem: 'X', vendorTag: 'BBL', printerCode: 'X1C' })).toBe(
      'Bambu Lab X1 Carbon',
    );
    expect(
      await index.modelOf({
        stem: 'X',
        vendorTag: 'Bambu Lab',
        printerCode: 'A1 mini',
        model: 'Bambu Lab A1 mini',
      }),
    ).toBe('Bambu Lab A1 mini');
    expect(await index.modelOf({ stem: 'Generic PLA' })).toBeNull();
  });
});

describe('loadSystemIndex edge cases', () => {
  it('throws a plain-English error when BBL.json is missing or invalid', async () => {
    await expect(loadSystemIndex(memFs())).rejects.toThrow(SystemIndexError);
    await expect(loadSystemIndex(memFs())).rejects.toThrow(/Could not read system\/BBL.json/);
    await expect(loadSystemIndex(memFs({ 'system/BBL.json': '{' }))).rejects.toThrow(
      /not valid JSON/,
    );
    await expect(loadSystemIndex(memFs({ 'system/BBL.json': '[]' }))).rejects.toThrow(
      /not a JSON object/,
    );
    await expect(loadSystemIndex(memFs({ 'system/BBL.json': '{}' }))).rejects.toThrow(
      /no "filament_list"/,
    );
  });

  it('warns about listed files that are missing and leaves them out', async () => {
    const fs = memFs({
      'system/BBL.json': bbl([
        { name: 'A @BBL X2D', sub_path: 'filament/A @BBL X2D.json' },
        { name: 'B @BBL X2D', sub_path: 'filament/B @BBL X2D.json' },
        { name: 'C @BBL P1P', sub_path: 'filament/P1P/C @BBL P1P.json' },
      ]),
      'system/BBL/filament/A @BBL X2D.json': preset({ name: 'A @BBL X2D' }),
    });
    const index = await loadSystemIndex(fs);
    expect(index.names()).toEqual(['A @BBL X2D']);
    expect(index.has('B @BBL X2D')).toBe(false);
    expect(index.missing.map((e) => e.name)).toEqual(['B @BBL X2D', 'C @BBL P1P']);
    expect(index.warnings).toHaveLength(2);
    expect(index.warnings[0]).toMatch(/"B @BBL X2D".*system\/BBL\/filament\/B @BBL X2D.json/);
  });

  it('can skip the file check', async () => {
    const fs = memFs({
      'system/BBL.json': bbl([{ name: 'B @BBL X2D', sub_path: 'filament/B @BBL X2D.json' }]),
    });
    const index = await loadSystemIndex(fs, { checkFiles: false });
    expect(index.has('B @BBL X2D')).toBe(true);
    expect(await index.load('B @BBL X2D')).toBeNull();
    expect(index.warnings[0]).toMatch(/could not be read/);
  });

  it('matches files case-insensitively, as Windows does', async () => {
    const fs = memFs({
      'system/BBL.json': bbl([{ name: 'A @BBL X2D', sub_path: 'filament/a @bbl x2d.json' }]),
      'system/BBL/filament/A @BBL X2D.json': preset({ name: 'A @BBL X2D' }),
    });
    const index = await loadSystemIndex(fs);
    expect(index.has('A @BBL X2D')).toBe(true);
    expect(index.missing).toEqual([]);
  });

  it('handles subfolders, backslashes, a BOM, duplicates and malformed entries', async () => {
    const fs = memFs({
      'system/BBL.json':
        BOM +
        JSON.stringify({
          version: '1',
          filament_list: [
            { name: 'C @BBL P1P', sub_path: 'filament\\P1P\\C @BBL P1P.json' },
            { name: 'C @BBL P1P', sub_path: 'filament/other.json' },
            { name: 42 },
            'junk',
          ],
        }),
      'system/BBL/filament/P1P/C @BBL P1P.json': BOM + preset({ name: 'C @BBL P1P' }),
    });
    const index = await loadSystemIndex(fs);
    expect(index.get('C @BBL P1P')?.path).toBe('system/BBL/filament/P1P/C @BBL P1P.json');
    expect((await index.load('C @BBL P1P'))?.name).toBe('C @BBL P1P');
    expect(index.warnings).toHaveLength(3);
    expect(index.warnings[0]).toMatch(/more than once/);
    expect(index.warnings[1]).toMatch(/malformed/);
  });

  it('warns on unreadable bodies and name mismatches', async () => {
    const fs = memFs({
      'system/BBL.json': bbl([
        { name: 'Bad', sub_path: 'filament/Bad.json' },
        { name: 'Arr', sub_path: 'filament/Arr.json' },
        { name: 'Named', sub_path: 'filament/Named.json' },
      ]),
      'system/BBL/filament/Bad.json': '{ "name": ',
      'system/BBL/filament/Arr.json': '[]',
      'system/BBL/filament/Named.json': preset({ name: 'Other' }),
    });
    const index = await loadSystemIndex(fs);
    expect(await index.loadAll()).toHaveLength(1);
    expect(index.warnings).toEqual([
      expect.stringMatching(/"Bad" could not be read/),
      expect.stringMatching(/"Arr" is not a JSON object/),
      expect.stringMatching(/named "Other" but listed as "Named"/),
    ]);
  });

  it('stops at inherit cycles and missing parents', async () => {
    const fs = memFs({
      'system/BBL.json': bbl([
        { name: 'A', sub_path: 'filament/A.json' },
        { name: 'B', sub_path: 'filament/B.json' },
        { name: 'C', sub_path: 'filament/C.json' },
      ]),
      'system/BBL/filament/A.json': preset({ name: 'A', inherits: 'B' }),
      'system/BBL/filament/B.json': preset({ name: 'B', inherits: 'A' }),
      'system/BBL/filament/C.json': preset({ name: 'C', inherits: 'Gone' }),
    });
    const index = await loadSystemIndex(fs);
    expect((await index.chain('A')).map((p) => p.name)).toEqual(['A', 'B']);
    expect(await index.effectiveCompatiblePrinters('A')).toBeNull();
    expect(index.warnings).toEqual([expect.stringMatching(/inherits loop/)]);
    expect((await index.chain('C')).map((p) => p.name)).toEqual(['C']);
  });

  it('uses the nearest compatible_printers and drops non-string items', async () => {
    const fs = memFs({
      'system/BBL.json': bbl([
        { name: 'Root', sub_path: 'filament/Root.json' },
        { name: 'Mid', sub_path: 'filament/Mid.json' },
        { name: 'Leaf', sub_path: 'filament/Leaf.json' },
      ]),
      'system/BBL/filament/Root.json': preset({ name: 'Root', compatible_printers: [] }),
      'system/BBL/filament/Mid.json': preset({
        name: 'Mid',
        inherits: 'Root',
        compatible_printers: ['Bambu Lab X2D 0.4 nozzle', 7],
      }),
      'system/BBL/filament/Leaf.json': preset({ name: 'Leaf', inherits: 'Mid' }),
    });
    const index = await loadSystemIndex(fs);
    expect(await index.effectiveCompatiblePrinters('Leaf')).toEqual(['Bambu Lab X2D 0.4 nozzle']);
    expect(await index.effectiveCompatiblePrinters('Root')).toEqual([]);
  });

  it('falls back to the most common model when no abbreviation matches', async () => {
    const fs = memFs({
      'system/BBL.json': bbl([
        { name: 'A @BBL Q9', sub_path: 'filament/A.json' },
        { name: 'B @BBL Q9', sub_path: 'filament/B.json' },
      ]),
      'system/BBL/filament/A.json': preset({
        name: 'A @BBL Q9',
        compatible_printers: ['Acme Nine 0.4 nozzle', 'Acme Other 0.4 nozzle'],
      }),
      'system/BBL/filament/B.json': preset({
        name: 'B @BBL Q9',
        compatible_printers: ['Acme Nine 0.4 nozzle', 'Acme Nine 0.6 nozzle'],
      }),
    });
    const index = await loadSystemIndex(fs);
    expect(await index.printerModel('BBL', 'Q9')).toBe('Acme Nine');
  });

  it('supports other vendors and lists', async () => {
    const fs = memFs({
      'system/Acme.json': JSON.stringify({
        process_list: [{ name: 'P', sub_path: 'process/P.json' }],
      }),
      'system/Acme/process/P.json': JSON.stringify({ name: 'P', type: 'process' }),
    });
    const index = await loadSystemIndex(fs, { vendor: 'Acme', listKey: 'process_list' });
    expect(index.version).toBeNull();
    expect((await index.load('P'))?.type).toBe('process');
  });
});

// Read-only check against the real install: PRESET_DOCTOR_LIVE=1 npx vitest run systemIndex
describe.runIf(process.env['PRESET_DOCTOR_LIVE'] === '1')('live system index', () => {
  const liveRoot = (): string => {
    const appData = process.env['APPDATA'];
    if (!appData) throw new Error('APPDATA is not set');
    return join(appData, 'BambuStudio');
  };

  it('loads every system filament preset quickly', async () => {
    const started = performance.now();
    const index = await loadSystemIndex(nodeFs(liveRoot(), { readOnly: true }));
    const all = await index.loadAll();
    const elapsed = performance.now() - started;
    expect(index.entries.size).toBeGreaterThan(1000);
    expect(all).toHaveLength(index.entries.size);
    expect(index.missing).toEqual([]);
    expect(index.warnings).toEqual([]);
    expect(elapsed).toBeLessThan(2000);
  });

  it('derives the printer model map', async () => {
    const index = await loadSystemIndex(nodeFs(liveRoot(), { readOnly: true }));
    const map = await index.printerModelMap();
    expect(map.get('BBL X1C')).toBe('Bambu Lab X1 Carbon');
    expect(map.get('BBL A1M')).toBe('Bambu Lab A1 mini');
    expect(map.get('BBL H2DP')).toBe('Bambu Lab H2D Pro');
    expect(map.get('BBL X2D')).toBe('Bambu Lab X2D');
    expect(map.get('BBL X1')).toBe('Bambu Lab X1');
    for (const [key, model] of map) expect(model, key).toMatch(/^Bambu Lab /);
  });

  it('confirms the real orphan parent is gone and its replacement exists', async () => {
    const index = await loadSystemIndex(nodeFs(liveRoot(), { readOnly: true }));
    expect(index.has('Generic PETG @BBL X2D 0.6 nozzle')).toBe(false);
    expect(await index.effectiveCompatiblePrinters('Generic PETG @BBL X2D')).toEqual([
      'Bambu Lab X2D 0.6 nozzle',
      'Bambu Lab X2D 0.8 nozzle',
    ]);
  });
});
