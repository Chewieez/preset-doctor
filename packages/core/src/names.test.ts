import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isBaseName,
  isTemplateName,
  looseName,
  modelAbbreviations,
  modelMatchesCode,
  parseCompatiblePrinter,
  parsePresetName,
  parseProcessName,
  sameNozzle,
  toggleDefaultNozzleSuffix,
} from './names.js';
import { FIXTURE_NAMES, fixtureRoot } from './testing/fixtures.js';

describe('parsePresetName', () => {
  it.each([
    ['Generic PLA @BBL X2D', { stem: 'Generic PLA', vendorTag: 'BBL', printerCode: 'X2D' }],
    [
      'Generic PETG @BBL X2D 0.6 nozzle',
      { stem: 'Generic PETG', vendorTag: 'BBL', printerCode: 'X2D', nozzle: '0.6' },
    ],
    [
      'Bambu PLA Basic @BBL A1M 0.2 nozzle',
      { stem: 'Bambu PLA Basic', vendorTag: 'BBL', printerCode: 'A1M', nozzle: '0.2' },
    ],
    [
      'Bambu PLA Basic @BBL H2DP',
      { stem: 'Bambu PLA Basic', vendorTag: 'BBL', printerCode: 'H2DP' },
    ],
    [
      'Elegoo Rapid PETG @Bambu Lab X2D 0.4 nozzle',
      {
        stem: 'Elegoo Rapid PETG',
        vendorTag: 'Bambu Lab',
        printerCode: 'X2D',
        model: 'Bambu Lab X2D',
        nozzle: '0.4',
      },
    ],
    [
      'My PLA @Bambu Lab A1 mini 0.6 nozzle',
      {
        stem: 'My PLA',
        vendorTag: 'Bambu Lab',
        printerCode: 'A1 mini',
        model: 'Bambu Lab A1 mini',
        nozzle: '0.6',
      },
    ],
    [
      'My PLA @Bambu Lab X1 Carbon 0.4 nozzle',
      {
        stem: 'My PLA',
        vendorTag: 'Bambu Lab',
        printerCode: 'X1 Carbon',
        model: 'Bambu Lab X1 Carbon',
        nozzle: '0.4',
      },
    ],
    ['Generic ABS @0.2 nozzle', { stem: 'Generic ABS', nozzle: '0.2' }],
    ['Generic PLA', { stem: 'Generic PLA' }],
    ['Anycubic Petg 06', { stem: 'Anycubic Petg 06' }],
    // Unrecognized tails fall back to a bare stem so nothing downstream mistakes them for printers.
    [
      'Bambu PLA Matte @BBL X2D 0.4 nozzle - Copy',
      { stem: 'Bambu PLA Matte @BBL X2D 0.4 nozzle - Copy' },
    ],
    ['test.json', { stem: 'test.json' }],
    ['@BBL X2D', { stem: '@BBL X2D' }],
    [' @BBL X2D', { stem: ' @BBL X2D' }],
    ['', { stem: '' }],
  ])('%s', (name, expected) => {
    expect(parsePresetName(name)).toEqual(expected);
  });

  it.each(['fdm_filament_pla', 'fdm_filament_template_direct_dual_e3d', 'Generic PLA @base'])(
    'returns null for building block %s',
    (name) => {
      expect(parsePresetName(name)).toBeNull();
    },
  );
});

describe('helpers', () => {
  it('recognizes templates and @base names', () => {
    expect(isTemplateName('fdm_filament_common')).toBe(true);
    expect(isTemplateName('Generic PLA')).toBe(false);
    expect(isBaseName('Bambu PLA Basic @base')).toBe(true);
    expect(isBaseName('Bambu PLA Basic @BBL X1C')).toBe(false);
  });

  it('parses compatible_printers entries', () => {
    expect(parseCompatiblePrinter('Bambu Lab X2D 0.6 nozzle')).toEqual({
      model: 'Bambu Lab X2D',
      nozzle: '0.6',
    });
    expect(parseCompatiblePrinter('Bambu Lab H2D Pro 0.4 nozzle')).toEqual({
      model: 'Bambu Lab H2D Pro',
      nozzle: '0.4',
    });
    expect(parseCompatiblePrinter('Bambu Lab X2D')).toBeNull();
    expect(parseCompatiblePrinter('0.4 nozzle')).toBeNull();
  });

  it('toggles the 0.4 nozzle suffix', () => {
    expect(toggleDefaultNozzleSuffix('Generic PLA @BBL X2D 0.4 nozzle')).toBe(
      'Generic PLA @BBL X2D',
    );
    expect(toggleDefaultNozzleSuffix('Bambu ABS @BBL X1C')).toBe('Bambu ABS @BBL X1C 0.4 nozzle');
    expect(toggleDefaultNozzleSuffix('Generic PLA @BBL X2D 0.6 nozzle')).toBeNull();
    expect(toggleDefaultNozzleSuffix('Generic PLA')).toBeNull();
    expect(toggleDefaultNozzleSuffix('Generic PLA @base')).toBeNull();
  });

  it('compares nozzle sizes by value', () => {
    expect(sameNozzle('0.4', '0.40')).toBe(true);
    expect(sameNozzle('0.4', '0.6')).toBe(false);
  });

  it('matches printer codes to model names without a table', () => {
    expect(modelMatchesCode('Bambu Lab X1 Carbon', 'X1C')).toBe(true);
    expect(modelMatchesCode('Bambu Lab A1 mini', 'A1M')).toBe(true);
    expect(modelMatchesCode('Bambu Lab H2D Pro', 'H2DP')).toBe(true);
    expect(modelMatchesCode('Bambu Lab X2D', 'X2D')).toBe(true);
    expect(modelMatchesCode('Bambu Lab X1', 'X1')).toBe(true);
    expect(modelMatchesCode('Bambu Lab X1', 'X1C')).toBe(false);
    expect(modelMatchesCode('Bambu Lab P1S', 'X1C')).toBe(false);
    expect(modelMatchesCode('Bambu Lab X1 Carbon', 'X1')).toBe(false);
    expect(modelAbbreviations('Bambu Lab A1 mini')).toContain('A1M');
  });
});

interface IndexEntry {
  name: string;
  sub_path: string;
}

function readIndexNames(bblJsonPath: string): string[] {
  const index = JSON.parse(readFileSync(bblJsonPath, 'utf8')) as { filament_list: IndexEntry[] };
  return index.filament_list.map((e) => e.name);
}

/** Every instantiable system name must yield a stem and either a printer or a nozzle. */
function expectAllParse(names: string[]): void {
  expect(names.length).toBeGreaterThan(0);
  const bad: string[] = [];
  for (const name of names) {
    const p = parsePresetName(name);
    if (p === null) {
      if (!isTemplateName(name) && !isBaseName(name)) bad.push(name);
      continue;
    }
    if (p.stem === '' || p.stem === name) {
      // Only tag-less generics ("Generic PLA") may have the whole name as stem.
      if (name.includes('@')) bad.push(name);
      continue;
    }
    if (p.printerCode === undefined && p.nozzle === undefined) bad.push(name);
    if (p.printerCode !== undefined && p.vendorTag !== 'BBL') bad.push(name);
  }
  expect(bad).toEqual([]);
}

describe('parseProcessName', () => {
  it.each([
    ['0.20mm Standard @BBL X1C', { layer: '0.20', profile: 'Standard', tag: 'BBL X1C' }],
    [
      '0.24mm Balanced Quality @BBL P2S 0.6 nozzle',
      { layer: '0.24', profile: 'Balanced Quality', tag: 'BBL P2S', nozzle: '0.6' },
    ],
    ['0.08mm Extra Fine @BBL H2D', { layer: '0.08', profile: 'Extra Fine', tag: 'BBL H2D' }],
    ['1mm Draft @Elegoo CC', { layer: '1', profile: 'Draft', tag: 'Elegoo CC' }],
  ])('%s', (name, expected) => {
    expect(parseProcessName(name)).toEqual(expected);
  });

  it.each(['fdm_process_common', 'fdm_process_bbl_0.20', '0.20mm Standard', 'Standard @BBL X1C'])(
    'rejects %s',
    (name) => {
      expect(parseProcessName(name)).toBeNull();
    },
  );
});

describe('looseName', () => {
  it('ignores case, surrounding space and runs of spaces', () => {
    expect(looseName('  0.20mm  Standard @BBL X1C ')).toBe('0.20mm standard @bbl x1c');
    expect(looseName('Bambu Lab X1 carbon 0.4 nozzle')).toBe(
      looseName('Bambu Lab X1 Carbon 0.4 nozzle'),
    );
    expect(looseName('a-b')).not.toBe(looseName('a b'));
  });
});

describe('fixture system index names', () => {
  it.each(FIXTURE_NAMES)('%s: every filament_list name parses', (fixture) => {
    expectAllParse(readIndexNames(join(fixtureRoot(fixture), 'system', 'BBL.json')));
  });
});

// Read-only check against the real install: npm run test:live -- names
describe.runIf(process.env['PRESET_DOCTOR_LIVE'] === '1')('live system index names', () => {
  it('every filament_list name parses', () => {
    const appData = process.env['APPDATA'];
    if (!appData) throw new Error('APPDATA is not set');
    const names = readIndexNames(join(appData, 'BambuStudio', 'system', 'BBL.json'));
    expect(names.length).toBeGreaterThan(1000);
    expectAllParse(names);
  });
});
