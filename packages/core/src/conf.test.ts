import { describe, expect, it } from 'vitest';
import { parseStudioConf, readStudioConf } from './conf.js';
import type { PresetFs } from './fs.js';
import { memFs } from './memFs.js';
import { nodeFs } from './node/nodeFs.js';
import { FIXTURE_NAMES, fixtureRoot } from './testing/fixtures.js';

const BOM = String.fromCharCode(0xfeff);
const TRAILER = '\n# MD5 checksum 184F5C37847FC6995D22314A9C46FB6B\n';

describe('readStudioConf on fixtures', () => {
  it.each(FIXTURE_NAMES)('%s: reads the sync flag despite the MD5 trailer', async (name) => {
    const conf = await readStudioConf(nodeFs(fixtureRoot(name), { readOnly: true }));
    expect(conf.found).toBe(true);
    expect(conf.error).toBeUndefined();
    expect(conf.syncUserPreset).toBe(name === 'broken-r1');
  });
});

describe('readStudioConf', () => {
  it('reports a missing file without throwing', async () => {
    expect(await readStudioConf(memFs())).toEqual({ found: false });
  });

  it('reports a read failure without throwing', async () => {
    const fs = {
      readText: () => Promise.reject(new Error('locked')),
    } as unknown as PresetFs;
    const conf = await readStudioConf(fs);
    expect(conf.found).toBe(true);
    expect(conf.error).toMatch(/locked/);
    expect(conf.syncUserPreset).toBeUndefined();
  });

  it('handles a large file', async () => {
    const big = { app: { sync_user_preset: false, filler: 'x'.repeat(5_000_000) }, other: [1, 2] };
    const conf = await readStudioConf(memFs({ 'BambuStudio.conf': JSON.stringify(big) + TRAILER }));
    expect(conf.syncUserPreset).toBe(false);
  });
});

describe('parseStudioConf', () => {
  it('parses CRLF, BOM and the trailer', () => {
    const text =
      BOM +
      '{\r\n    "app": {\r\n        "sync_user_preset": true\r\n    }\r\n}\r\n# MD5 checksum AB\r\n';
    expect(parseStudioConf(text)).toMatchObject({ found: true, syncUserPreset: true });
  });

  it('accepts string and number booleans', () => {
    expect(parseStudioConf('{"app":{"sync_user_preset":"true"}}').syncUserPreset).toBe(true);
    expect(parseStudioConf('{"app":{"sync_user_preset":"0"}}').syncUserPreset).toBe(false);
    expect(parseStudioConf('{"app":{"sync_user_preset":1}}').syncUserPreset).toBe(true);
  });

  it('leaves the flag unset when absent or odd', () => {
    const absent = parseStudioConf('{"app":{"language":"en"}}');
    expect(absent.syncUserPreset).toBeUndefined();
    expect(absent.error).toBeUndefined();
    expect(parseStudioConf('{"app":{"sync_user_preset":"maybe"}}').syncUserPreset).toBeUndefined();
  });

  it('reports a missing app section', () => {
    const conf = parseStudioConf('[]');
    expect(conf.error).toMatch(/app/);
    expect(conf.syncUserPreset).toBeUndefined();
  });

  it('still finds the flag in a damaged file', () => {
    const conf = parseStudioConf('{"app":{"sync_user_preset": true, "x": ');
    expect(conf.error).toMatch(/not valid JSON/);
    expect(conf.syncUserPreset).toBe(true);
    expect(parseStudioConf('garbage')).toMatchObject({ found: true });
    expect(parseStudioConf('garbage').syncUserPreset).toBeUndefined();
    expect(parseStudioConf('').syncUserPreset).toBeUndefined();
  });
});

describe('parseStudioConf: printers', () => {
  const text = (v: unknown) => JSON.stringify(v) + TRAILER;

  it('reads the selected printer and process and the added models', () => {
    const conf = parseStudioConf(
      text({
        app: { sync_user_preset: false },
        models: [
          { vendor: 'BBL', model: 'Bambu Lab X2D', nozzle_diameter: '0.2;0.4;0.6;0.8' },
          { vendor: 'BBL', model: 'Bambu Lab P1S', nozzle_diameter: '0.4' },
        ],
        presets: {
          machine: 'Bambu Lab X2D 0.4 nozzle',
          process: '0.20mm Standard @BBL X2D.ini',
          filaments: ['Generic PLA @BBL X2D 0.4 nozzle'],
        },
        access_code: { secret: 'never read' },
      }),
    );
    expect(conf).toEqual({
      found: true,
      syncUserPreset: false,
      selectedPrinter: 'Bambu Lab X2D 0.4 nozzle',
      selectedProcess: '0.20mm Standard @BBL X2D',
      enabledModels: [
        { vendor: 'BBL', model: 'Bambu Lab X2D', nozzles: ['0.2', '0.4', '0.6', '0.8'] },
        { vendor: 'BBL', model: 'Bambu Lab P1S', nozzles: ['0.4'] },
      ],
    });
  });

  it('keeps an empty models list, and skips odd shapes', () => {
    expect(parseStudioConf(text({ app: {}, models: [] })).enabledModels).toEqual([]);
    const odd = parseStudioConf(
      text({ app: {}, models: [{ vendor: 'BBL' }, 'x', { model: 'M' }], presets: [] }),
    );
    expect(odd.enabledModels).toEqual([{ vendor: '', model: 'M', nozzles: [] }]);
    expect(odd.selectedPrinter).toBeUndefined();
    const notList = parseStudioConf(text({ app: {}, models: {}, presets: { machine: 3 } }));
    expect(notList.enabledModels).toBeUndefined();
    expect(notList.selectedPrinter).toBeUndefined();
  });

  it('reads no printers from a damaged file', () => {
    const conf = parseStudioConf('{"models": [{"vendor": "BBL", "model": "X"}], "app": {');
    expect(conf.error).toMatch(/not valid JSON/);
    expect(conf.enabledModels).toBeUndefined();
  });
});
