import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PresetFs } from './fs.js';
import { memFs } from './memFs.js';
import { nodeFs } from './node/nodeFs.js';
import {
  LIST_KEY,
  SystemIndexError,
  loadSystemIndex,
  loadSystemIndexes,
  loadSystemIndexSet,
  studioNameLookup,
} from './systemIndex.js';
import { fakeStudio } from './testing/studio.js';
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
      vendor: 'BBL',
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
  it('names the real cause when BBL.json exists but cannot be read', async () => {
    const fs = memFs({ 'system/BBL.json': '{}' });
    const cause = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    fs.readText = async () => {
      throw cause;
    };
    const err = await loadSystemIndex(fs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SystemIndexError);
    expect((err as Error).message).toBe(
      'Could not read system/BBL.json: EPERM: operation not permitted',
    );
    expect((err as Error).cause).toBe(cause);
    // Missing: the friendly guess, still with its cause.
    const missing = await loadSystemIndex(memFs()).catch((e: unknown) => e);
    expect((missing as Error).message).toContain('Is this a Bambu Studio folder');
    expect((missing as Error).cause).toBeDefined();
  });

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

  it('throws, rather than calling every preset missing, when the vendor folder is gone or unreadable', async () => {
    const list = [
      { name: 'A @BBL X2D', sub_path: 'filament/A @BBL X2D.json' },
      { name: 'C @BBL P1P', sub_path: 'filament/P1P/C @BBL P1P.json' },
    ];
    // Only BBL.json was copied.
    const gone = memFs({ 'system/BBL.json': bbl(list) });
    await expect(loadSystemIndex(gone)).rejects.toThrow(SystemIndexError);
    await expect(loadSystemIndex(gone)).rejects.toThrow(/None of the 2 .*system\\BBL folder/);

    // A folder that exists but can't be listed means "unknown", even if others are fine.
    const inner = memFs({
      'system/BBL.json': bbl(list),
      'system/BBL/filament/A @BBL X2D.json': preset({ name: 'A @BBL X2D' }),
      'system/BBL/filament/P1P/C @BBL P1P.json': preset({ name: 'C @BBL P1P' }),
    });
    const locked: PresetFs = {
      ...inner,
      list: async (dir) => {
        if (dir === 'system/BBL/filament/P1P') throw new Error('EPERM: operation not permitted');
        return inner.list(dir);
      },
    };
    await expect(loadSystemIndex(locked)).rejects.toThrow(
      /Could not read the system presets in system\/BBL\/filament\/P1P \(EPERM/,
    );
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
      expect.stringMatching(
        /named "Other" but listed as "Named"; Studio uses the name in the file/,
      ),
    ]);
  });

  it('finds presets by the name in their file, as Studio does', async () => {
    // Profile 02.00.00.83 lists "SUNLU PETG @BBL A1M" for a file named "... 0.4 nozzle".
    const fs = countingFs(
      memFs({
        'system/BBL.json': bbl([
          { name: 'Foo @BBL A1M', sub_path: 'filament/Foo @BBL A1M.json' },
          { name: 'Foo @BBL A1M 0.2 nozzle', sub_path: 'filament/Foo @BBL A1M 0.2 nozzle.json' },
          { name: 'Bar @BBL A1M', sub_path: 'filament/Bar @BBL A1M.json' },
          { name: 'Unread @BBL A1M', sub_path: 'filament/Unread @BBL A1M.json' },
        ]),
        'system/BBL/filament/Foo @BBL A1M.json': preset({ name: 'Foo @BBL A1M 0.4 nozzle' }),
        'system/BBL/filament/Foo @BBL A1M 0.2 nozzle.json': preset({
          name: 'Foo @BBL A1M 0.2 nozzle',
        }),
        'system/BBL/filament/Bar @BBL A1M.json': preset({}),
        'system/BBL/filament/Unread @BBL A1M.json': '{ "name": ',
      }),
    );
    const index = await loadSystemIndex(fs);
    const found = async (name: string) => (await index.findByStudioName(name))?.name ?? null;
    expect(await found('Foo @BBL A1M 0.4 nozzle')).toBe('Foo @BBL A1M');
    expect(await found('Foo @BBL A1M')).toBeNull();
    expect(await found('Foo @BBL A1M 0.2 nozzle')).toBe('Foo @BBL A1M 0.2 nozzle');
    // No name in the file: Studio's name is the index name. Unreadable: never "missing".
    expect(await found('Bar @BBL A1M')).toBe('Bar @BBL A1M');
    expect(await found('Unread @BBL A1M')).toBe('Unread @BBL A1M');
    expect(await found('Nothing @BBL A1M')).toBeNull();
    expect(await found('Unread @BBL A1M 0.6 nozzle')).toBe('Unread @BBL A1M');
    expect(await found('')).toBeNull();
    expect((await index.load('Foo @BBL A1M'))?.studioName).toBe('Foo @BBL A1M 0.4 nozzle');
    // Only same-stem files were read.
    expect(fs.reads.filter((p) => p.includes('Bar'))).toEqual([
      'system/BBL/filament/Bar @BBL A1M.json',
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
    expect(await index.effectiveCompatiblePrinters('A')).toBeNull();
    expect(index.warnings).toEqual([expect.stringMatching(/inherits loop/)]);
    expect(await index.effectiveCompatiblePrinters('C')).toBeNull();
    expect(index.warnings).toEqual([expect.stringMatching(/inherits loop/)]);
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
    expect((await index.load('P'))?.path).toBe('system/Acme/process/P.json');
  });
});

describe('process and printer indexes', () => {
  it('reads process_list and machine_list of the types fixture', async () => {
    const set = await loadSystemIndexSet(fixtureFs('types-bambu'));
    expect(set.errors).toEqual({});
    expect(set.version).toBe('02.08.00.06');
    expect(set.byType.process?.names()).toContain('0.20mm Standard @BBL X1C');
    expect(set.byType.process?.has('Generic PLA @BBL X2D')).toBe(false);
    expect(set.byType.machine?.names()).toContain('Bambu Lab X1 Carbon 0.4 nozzle');
    expect(set.byType.filament?.names()).toContain('Generic PLA @BBL X2D');
    expect(set.warnings).toEqual([]);
  });

  it('inherits printer_model and compatible_printers through the chain', async () => {
    const set = await loadSystemIndexSet(fixtureFs('types-bambu'));
    const machine = set.byType.machine!;
    expect(await machine.effectiveValue('Bambu Lab X2D 0.6 nozzle', 'printerModel')).toBe(
      'Bambu Lab X2D',
    );
    expect(await machine.effectiveValue('Bambu Lab X2D 0.6 nozzle', 'printerVariant')).toBe('0.6');
    const proc = set.byType.process!;
    expect(await proc.effectiveCompatiblePrinters('0.20mm Standard @BBL X1C')).toContain(
      'Bambu Lab X1 Carbon 0.4 nozzle',
    );
    expect(await proc.effectiveValue('fdm_process_common', 'printerModel')).toBeNull();
  });

  it('treats a missing process or machine list as empty, and a missing filament list as an error', async () => {
    const fs = memFs({
      'system/BBL.json': JSON.stringify({ name: 'Bambulab', version: '01.02.03.04' }),
    });
    const set = await loadSystemIndexSet(fs);
    expect(set.byType.process?.names()).toEqual([]);
    expect(set.byType.machine?.names()).toEqual([]);
    expect(set.byType.filament).toBeNull();
    expect(set.errors.filament).toBeInstanceOf(SystemIndexError);
    const one = await loadSystemIndexes(fs, { listKey: LIST_KEY.process, optionalList: true });
    expect(one.names()).toEqual([]);
    await expect(loadSystemIndexes(fs, { listKey: LIST_KEY.process })).rejects.toThrow(
      SystemIndexError,
    );
  });

  it('studioNameLookup: a template that presets cannot be based on is no parent', async () => {
    const fs = fakeStudio(
      [
        { name: 'Generic PLA @base', instantiation: 'false' },
        { name: 'Generic PLA @BBL X2D', inherits: 'Generic PLA @base' },
      ],
      [],
    );
    const index = await loadSystemIndexes(fs);
    const lookup = await studioNameLookup(index, [
      { json: { inherits: 'Generic PLA @base' } },
      { json: { inherits: 'Generic PLA @BBL X2D' } },
    ]);
    expect(lookup.get('Generic PLA @base')).toBeUndefined();
    expect(lookup.get('Generic PLA @BBL X2D')?.name).toBe('Generic PLA @BBL X2D');
    // Names no preset asked about fall back to the index.
    expect(lookup.get('Generic PLA @base ')).toBeUndefined();
  });
});

// Read-only check against the real install: npm run test:live -- systemIndex
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

  it('derives printer models from the data', async () => {
    const index = await loadSystemIndex(nodeFs(liveRoot(), { readOnly: true }));
    expect(await index.printerModel('BBL', 'X1C')).toBe('Bambu Lab X1 Carbon');
    expect(await index.printerModel('BBL', 'A1M')).toBe('Bambu Lab A1 mini');
    expect(await index.printerModel('BBL', 'H2DP')).toBe('Bambu Lab H2D Pro');
    expect(await index.printerModel('BBL', 'X2D')).toBe('Bambu Lab X2D');
    expect(await index.printerModel('BBL', 'X1')).toBe('Bambu Lab X1');
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
