// "Offer on more nozzle sizes": the scan's nozzle offers (compat.ts nozzleOffer), the edit that
// widens compatible_printers (fix.ts), and the JSON helper it uses (jsonFile.ts).
import { describe, expect, it } from 'vitest';
import { applyChanges, FixError, nozzleWords, planFixes } from './fix.js';
import { setJsonStringArray } from './jsonFile.js';
import { scan } from './scan.js';
import { fakeStudio, type FakeSystemPreset, type FakeUserPreset } from './testing/studio.js';
import type { PresetSummary, ScanResult } from './types.js';

const X2D = (n: string) => `Bambu Lab X2D ${n} nozzle`;
const P1S = 'Bambu Lab P1S 0.4 nozzle';

const TRAILER = '# MD5 checksum 00000000000000000000000000000000\n';
const CONF =
  JSON.stringify(
    {
      app: { sync_user_preset: false },
      models: [
        { vendor: 'BBL', model: 'Bambu Lab X2D', nozzle_diameter: '0.4;0.6;0.8' },
        { vendor: 'BBL', model: 'Bambu Lab P1S', nozzle_diameter: '0.4' },
      ],
      presets: { machine: X2D('0.4') },
    },
    null,
    4,
  ) +
  '\n' +
  TRAILER;

const machine = (name: string, model: string, variant: string): FakeSystemPreset => ({
  type: 'machine',
  name,
  inherits: 'fdm_machine_common',
  extra: { printer_model: model, printer_variant: variant },
});

const SYSTEM: FakeSystemPreset[] = [
  { type: 'machine', name: 'fdm_machine_common', instantiation: 'false', extra: { type: null } },
  // 0.2 exists but isn't added, so it is never offered.
  machine(X2D('0.2'), 'Bambu Lab X2D', '0.2'),
  machine(X2D('0.4'), 'Bambu Lab X2D', '0.4'),
  machine(X2D('0.6'), 'Bambu Lab X2D', '0.6'),
  machine(X2D('0.8'), 'Bambu Lab X2D', '0.8'),
  machine(P1S, 'Bambu Lab P1S', '0.4'),
  { type: 'process', name: 'fdm_process_common', instantiation: 'false' },
  {
    type: 'process',
    name: '0.20mm Standard @BBL X2D',
    inherits: 'fdm_process_common',
    compatible_printers: [X2D('0.4')],
  },
  { name: 'fdm_filament_common', instantiation: 'false', compatible_printers: [] },
  { name: 'Generic PLA @base', inherits: 'fdm_filament_common', instantiation: 'false' },
  {
    name: 'Generic PLA @BBL X2D 0.4 nozzle',
    inherits: 'Generic PLA @base',
    compatible_printers: [X2D('0.4')],
  },
  {
    name: 'Generic PLA @BBL X2D',
    inherits: 'Generic PLA @base',
    compatible_printers: [X2D('0.6'), X2D('0.8')],
  },
  { name: 'Generic PLA @BBL P1S', inherits: 'Generic PLA @base', compatible_printers: [P1S] },
];

const fil = (name: string, inherits: string, extra?: Record<string, unknown>): FakeUserPreset => ({
  name,
  inherits,
  ...(extra ? { extra } : {}),
});

function studio(user: FakeUserPreset[]) {
  return fakeStudio(SYSTEM, user, { conf: CONF });
}

function row(r: ScanResult, name: string): PresetSummary {
  const p = r.presets.find((x) => x.name === name);
  if (!p) throw new Error(`no row ${name}`);
  return p;
}

describe('nozzle offers in the scan', () => {
  it('offers the added sizes of the same printer that the list lacks, smallest first', async () => {
    const r = await scan(
      studio([
        fil('From 0.4', 'Generic PLA @BBL X2D 0.4 nozzle'),
        fil('Own 0.6', 'Generic PLA @BBL X2D', { compatible_printers: [X2D('0.6')] }),
      ]),
    );
    expect(row(r, 'From 0.4').compat?.moreNozzles).toEqual({
      add: [X2D('0.6'), X2D('0.8')],
      printers: [X2D('0.4'), X2D('0.6'), X2D('0.8')],
      models: [{ model: 'Bambu Lab X2D', has: ['0.4'], add: ['0.6', '0.8'] }],
    });
    expect(row(r, 'Own 0.6').compat?.moreNozzles).toEqual({
      add: [X2D('0.4'), X2D('0.8')],
      printers: [X2D('0.6'), X2D('0.4'), X2D('0.8')],
      models: [{ model: 'Bambu Lab X2D', has: ['0.6'], add: ['0.4', '0.8'] }],
    });
    // Not a problem: the rows stay as they were.
    expect(row(r, 'From 0.4').status).toBe('info');
  });

  it('offers nothing when there is nothing to add or the list must not be touched', async () => {
    const r = await scan(
      studio([
        // Already every added size.
        fil('All sizes', 'Generic PLA @BBL X2D 0.4 nozzle', {
          compatible_printers: [X2D('0.4'), X2D('0.6'), X2D('0.8')],
        }),
        // No list: offered for every printer already.
        fil('Open', 'Generic PLA @BBL X2D', { compatible_printers: [] }),
        // P1S has only 0.4 added.
        fil('For P1S', 'Generic PLA @BBL P1S'),
        // A custom filament: its copies share one name in Studio.
        { name: 'Custom @Bambu Lab X2D 0.4 nozzle', base: true, inherits: '' },
        // Process presets are made per nozzle size; only filaments get the offer.
        {
          type: 'process',
          name: 'My process',
          inherits: '0.20mm Standard @BBL X2D',
        },
      ]),
    );
    for (const name of [
      'All sizes',
      'Open',
      'For P1S',
      'Custom @Bambu Lab X2D 0.4 nozzle',
      'My process',
    ]) {
      expect(row(r, name).compat?.moreNozzles, name).toBeUndefined();
    }
  });

  it('never offers a nozzle size that is not added, nor touches a hidden preset', async () => {
    const r = await scan(
      studio([
        fil('Only 0.2', 'Generic PLA @BBL X2D 0.4 nozzle', { compatible_printers: [X2D('0.2')] }),
        fil('Orphan', 'Generic PLA @BBL X2D 0.6 nozzle'),
      ]),
    );
    expect(row(r, 'Only 0.2').compat?.state).toBe('nozzle-not-added');
    expect(row(r, 'Only 0.2').compat?.moreNozzles).toBeUndefined();
    // Offered for an added printer (P1S), but listed for the X2D only with a size that isn't
    // added: that model gets nothing (R3 says to add the nozzle instead).
    const mixed = await scan(
      studio([
        fil('Mixed', 'Generic PLA @BBL X2D 0.4 nozzle', {
          compatible_printers: [P1S, X2D('0.2')],
        }),
      ]),
    );
    expect(row(mixed, 'Mixed').compat?.state).toBe('other-printer');
    expect(row(mixed, 'Mixed').compat?.moreNozzles).toBeUndefined();
    expect(row(r, 'Orphan').status).toBe('hidden');
    expect(row(r, 'Orphan').compat).toBeUndefined();
  });

  it('words the sizes per printer model', () => {
    expect(
      nozzleWords({
        add: [],
        printers: [],
        models: [
          { model: 'Bambu Lab X2D', has: ['0.4'], add: ['0.2', '0.6', '0.8'] },
          { model: 'Bambu Lab P1S', has: ['0.4'], add: ['0.6'] },
        ],
      }),
    ).toBe('the Bambu Lab X2D 0.2, 0.6 and 0.8 mm nozzles and the Bambu Lab P1S 0.6 mm nozzle');
  });
});

describe('offering a preset on more nozzle sizes', () => {
  it('adds the list where Studio sorts it, or widens the own list; a rescan sees it', async () => {
    const fs = studio([
      fil('From 0.4', 'Generic PLA @BBL X2D 0.4 nozzle', { nozzle_temperature: ['215'] }),
      fil('Own 0.6', 'Generic PLA @BBL X2D', { compatible_printers: [X2D('0.6')] }),
    ]);
    const r = await scan(fs);
    const changes = await planFixes(
      fs,
      r,
      ['From 0.4', 'Own 0.6'].map((n) => ({ presetPath: row(r, n).path, allNozzles: true })),
    );
    expect(changes).toHaveLength(2);
    const [from04, own06] = changes;
    expect(from04!.description).toBe('Offer it for the Bambu Lab X2D 0.6 and 0.8 mm nozzles too.');
    // Every other line stays; the new key goes before "filament_settings_id" (sorted order).
    const before = JSON.parse(from04!.before) as Record<string, unknown>;
    const after = JSON.parse(from04!.after) as Record<string, unknown>;
    expect(after).toEqual({
      ...before,
      compatible_printers: [X2D('0.4'), X2D('0.6'), X2D('0.8')],
    });
    expect(Object.keys(after).indexOf('compatible_printers')).toBe(0);
    expect(from04!.after).toContain(
      '    "compatible_printers": [\n        "Bambu Lab X2D 0.4 nozzle",\n',
    );
    expect(JSON.parse(own06!.after)).toMatchObject({
      compatible_printers: [X2D('0.6'), X2D('0.4'), X2D('0.8')],
    });

    await applyChanges(fs, changes);
    const again = await scan(fs);
    for (const n of ['From 0.4', 'Own 0.6']) {
      expect(row(again, n).compat).toMatchObject({ state: 'selected', source: { kind: 'own' } });
      expect(row(again, n).compat?.moreNozzles).toBeUndefined();
    }
  });

  it('plans a list with a stray non-string item instead of calling it changed', async () => {
    const fs = studio([
      fil('Stray', 'Generic PLA @BBL X2D 0.4 nozzle', {
        compatible_printers: [X2D('0.4'), null],
      }),
    ]);
    const r = await scan(fs);
    expect(row(r, 'Stray').compat?.moreNozzles?.add).toEqual([X2D('0.6'), X2D('0.8')]);
    const [change] = await planFixes(fs, r, [
      { presetPath: row(r, 'Stray').path, allNozzles: true },
    ]);
    expect(JSON.parse(change!.after)).toMatchObject({
      compatible_printers: [X2D('0.4'), X2D('0.6'), X2D('0.8')],
    });
  });

  it('refuses a preset without an offer, and one whose list changed since the scan', async () => {
    const fs = studio([
      fil('From 0.4', 'Generic PLA @BBL X2D 0.4 nozzle'),
      fil('For P1S', 'Generic PLA @BBL P1S'),
    ]);
    const r = await scan(fs);
    await expect(
      planFixes(fs, r, [{ presetPath: row(r, 'For P1S').path, allNozzles: true }]),
    ).rejects.toThrow(FixError);

    const path = row(r, 'From 0.4').path;
    const text = await fs.readText(path);
    await fs.writeText(
      path,
      text.replace('{', `{\n    "compatible_printers": [${JSON.stringify(X2D('0.6'))}],`),
    );
    const stale = planFixes(fs, r, [{ presetPath: path, allNozzles: true }]);
    await expect(stale).rejects.toThrow(/changed since the scan/);
    await expect(stale).rejects.toMatchObject({ stale: true });
  });
});

describe('setJsonStringArray', () => {
  const studioText = '{\n    "a": "1",\n    "list": [\n        "x"\n    ],\n    "z": "2"\n}';

  it('replaces an existing array in place, in the file layout', () => {
    expect(setJsonStringArray(studioText, 'list', ['x', 'y'])).toBe(
      '{\n    "a": "1",\n    "list": [\n        "x",\n        "y"\n    ],\n    "z": "2"\n}',
    );
    expect(setJsonStringArray(studioText, 'list', [])).toBe(
      '{\n    "a": "1",\n    "list": [],\n    "z": "2"\n}',
    );
  });

  it('adds a missing key in sorted position, or last, keeping CRLF', () => {
    expect(setJsonStringArray(studioText, 'm', ['v'])).toBe(
      '{\n    "a": "1",\n    "list": [\n        "x"\n    ],\n    "m": [\n        "v"\n    ],\n    "z": "2"\n}',
    );
    const crlf = '{\r\n    "a": "1",\r\n    "b": [\r\n        "x"\r\n    ]\r\n}\r\n';
    expect(setJsonStringArray(crlf, 'c', ['v'])).toBe(
      '{\r\n    "a": "1",\r\n    "b": [\r\n        "x"\r\n    ],\r\n    "c": [\r\n        "v"\r\n    ]\r\n}\r\n',
    );
    expect(JSON.parse(setJsonStringArray('{"b": 1}', 'a', ['q']))).toEqual({ a: ['q'], b: 1 });
  });

  it('refuses a non-array value, a duplicated key and an empty object', () => {
    expect(() => setJsonStringArray('{"a": "s"}', 'a', [])).toThrow(/not an array/);
    expect(() => setJsonStringArray('{"a": [], "a": []}', 'a', [])).toThrow(/more than once/);
    expect(() => setJsonStringArray('{}', 'a', [])).toThrow(/no keys/);
  });
});
