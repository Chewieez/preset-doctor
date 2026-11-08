import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ApplyError,
  applyChanges,
  defaultChoices,
  findStale,
  FixError,
  planFixes,
  StaleChangeError,
} from './fix.js';
import type { PresetFs } from './fs.js';
import { memFs } from './memFs.js';
import { nodeFs } from './node/nodeFs.js';
import { R1_ID } from './rules/r1.js';
import { scan } from './scan.js';
import { fixtureRoot } from './testing/fixtures.js';
import { fakeStudio, sidecar, tempFixture } from './testing/studio.js';
import { RULE_IDS, type Change, type ScanResult } from './types.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function temp(name: Parameters<typeof tempFixture>[0]): string {
  const t = tempFixture(name);
  cleanups.push(t.cleanup);
  return t.dir;
}

/** Lines that differ between two texts of equal line count. */
function changedLines(a: string, b: string): [string, string][] {
  const la = a.split('\n');
  const lb = b.split('\n');
  expect(la.length).toBe(lb.length);
  return la.flatMap((l, i) => (l === lb[i] ? [] : [[l, lb[i]!] as [string, string]]));
}

describe('planFixes', () => {
  it('broken-r1: one-line inherits edits plus base_id where a sidecar exists', async () => {
    const fs = nodeFs(fixtureRoot('broken-r1'), { readOnly: true });
    const r = await scan(fs);
    const choices = defaultChoices(r);
    expect(choices).toHaveLength(19);
    const changes = await planFixes(fs, r, choices);

    const json = changes.filter((c) => c.path.endsWith('.json'));
    const info = changes.filter((c) => c.path.endsWith('.info'));
    expect(json).toHaveLength(19);
    for (const c of json) expect(changedLines(c.before, c.after)).toHaveLength(1);

    const petg = json.find((c) => c.path.endsWith('/Anycubic Petg 06.json'))!;
    expect(changedLines(petg.before, petg.after)).toEqual([
      [
        '    "inherits": "Generic PETG @BBL X2D 0.6 nozzle",',
        '    "inherits": "Generic PETG @BBL X2D",',
      ],
    ]);
    expect(petg.description).toBe(
      'Set its parent to "Generic PETG @BBL X2D" (was "Generic PETG @BBL X2D 0.6 nozzle").',
    );

    // Of the pre-selected fixes, only Synthetic Added Suffix has a sidecar. (Synthetic Stripped
    // Suffix has one too, but its nozzle size is unsure, so nothing is pre-selected for it.)
    expect(info.map((c) => c.path.slice(c.path.lastIndexOf('/') + 1))).toEqual([
      'Synthetic Added Suffix.info',
    ]);
    const added = info[0]!;
    expect(changedLines(added.before, added.after)).toEqual([
      ['base_id = GFSG99_15\r', 'base_id = GFSB00\r'],
    ]);
  });

  it('leaves sidecars alone with updateBaseId: false', async () => {
    const fs = nodeFs(fixtureRoot('broken-r1'), { readOnly: true });
    const r = await scan(fs);
    const changes = await planFixes(fs, r, defaultChoices(r), { updateBaseId: false });
    expect(changes.every((c) => c.path.endsWith('.json'))).toBe(true);
  });

  it('broken-r4: nothing to rename, since Studio itself saved "test.json" as test.json', async () => {
    const fs = nodeFs(fixtureRoot('broken-r4'), { readOnly: true });
    const r = await scan(fs);
    expect(defaultChoices(r)).toEqual([]);
  });

  it('renames a real name/file mismatch, keeping CRLF and filament_settings_id in step', async () => {
    // The broken-r4 test.json (CRLF, name "test.json") under another file name.
    const dir = temp('broken-r4');
    const folder = join(dir, 'user', '1000000001', 'filament');
    renameSync(join(folder, 'test.json'), join(folder, 'Old copy.json'));
    renameSync(join(folder, 'test.info'), join(folder, 'Old copy.info'));
    const fs = nodeFs(dir, { readOnly: true });
    const r = await scan(fs);
    const [change, ...more] = await planFixes(fs, r, defaultChoices(r));
    expect(more).toEqual([]);
    expect(change?.path).toBe('user/1000000001/filament/Old copy.json');
    expect(change?.before).toContain('\r\n');
    expect(changedLines(change!.before, change!.after)).toEqual([
      ['        "test.json"\r', '        "Old copy"\r'],
      ['    "name": "test.json",\r', '    "name": "Old copy",\r'],
    ]);
  });

  it('never re-parents an orphan onto a preset that the same repair renames', async () => {
    const fs = fakeStudio(
      [{ name: 'Generic PLA @BBL X1C', compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'] }],
      [
        {
          file: 'My PLA @BBL X1C (2)',
          name: 'My PLA @BBL X1C',
          inherits: 'Generic PLA @BBL X1C',
          info: sidecar('GFL99'),
        },
        { name: 'Child', inherits: 'My PLA @BBL X1C 0.4 nozzle', info: sidecar('GFL99') },
      ],
    );
    const parentPath = 'user/1000000001/filament/My PLA @BBL X1C (2).json';
    const childPath = 'user/1000000001/filament/Child.json';
    const r = await scan(fs);
    // R1 doesn't offer a top-level preset whose name and file differ (Studio couldn't use it as a
    // parent), so offer it by hand to check the guard behind that.
    const child = r.findings.find((f) => f.ruleId === R1_ID && f.presetPath === childPath)!;
    expect(child.proposedFix).toBeUndefined();
    child.proposedFix = {
      kind: 'setInherits',
      candidates: [
        {
          name: 'My PLA @BBL X1C',
          confidence: 'high',
          reason: '',
          preselected: true,
          source: 'user',
        },
      ],
    };
    await expect(
      planFixes(fs, r, [
        { presetPath: childPath, candidateName: 'My PLA @BBL X1C' },
        { presetPath: parentPath, rename: true },
      ]),
    ).rejects.toThrow(
      '"My PLA @BBL X1C" is renamed in the same repair, so it can\'t also be the new parent of "Child"',
    );
  });

  it('refuses to edit a file that is not valid UTF-8, which would rewrite its bad bytes', async () => {
    const fs = fakeStudio(
      [{ name: 'Generic PLA @BBL X2D', compatible_printers: ['Bambu Lab X2D 0.6 nozzle'] }],
      [{ name: 'Mine', inherits: 'Generic PLA @BBL X2D 0.6 nozzle', info: sidecar('x') }],
    );
    const path = 'user/1000000001/filament/Mine.json';
    const r = await scan(fs);
    // Saved as ANSI after the scan: "215 °C" with a raw 0xB0 byte.
    const text = (await fs.readText(path)).replace(
      '"from"',
      '"filament_notes": "215 \u0000C", "from"',
    );
    const bytes = new TextEncoder().encode(text);
    bytes[bytes.indexOf(0)] = 0xb0;
    await fs.writeBytes(path, bytes);
    await expect(
      planFixes(fs, r, [{ presetPath: path, candidateName: 'Generic PLA @BBL X2D' }]),
    ).rejects.toThrow('is not valid UTF-8 text');
    // A fresh scan reports the file as damaged instead, with nothing to plan.
    const again = await scan(fs);
    expect(again.findings.map((f) => f.title)).toEqual(['File is damaged']);
    expect(again.findings[0]?.explanation).toContain('not valid UTF-8 text');
    expect(Array.from(await fs.readBytes(path))).toEqual(Array.from(bytes));
  });

  it('still plans every repair when a sidecar is a folder or locked, leaving that base_id alone', async () => {
    const fs = fakeStudio(
      [
        {
          name: 'Generic PLA @BBL X2D',
          setting_id: 'GFSL99_20',
          compatible_printers: ['Bambu Lab X2D 0.6 nozzle'],
        },
      ],
      [
        { name: 'Boxed', inherits: 'Generic PLA @BBL X2D 0.6 nozzle' },
        { name: 'Locked', inherits: 'Generic PLA @BBL X2D 0.6 nozzle', info: sidecar('OLD') },
        { name: 'Fine', inherits: 'Generic PLA @BBL X2D 0.6 nozzle', info: sidecar('OLD') },
      ],
    );
    const dir = 'user/1000000001/filament';
    await fs.mkdir(`${dir}/Boxed.info`);
    const readBytes = fs.readBytes.bind(fs);
    const readText = fs.readText.bind(fs);
    const busy = (): never => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    };
    fs.readBytes = async (p) => (p === `${dir}/Locked.info` ? busy() : readBytes(p));
    fs.readText = async (p) => (p === `${dir}/Locked.info` ? busy() : readText(p));

    const r = await scan(fs);
    expect(defaultChoices(r)).toHaveLength(3);
    const changes = await planFixes(fs, r, defaultChoices(r));
    expect(changes.map((c) => c.path)).toEqual([
      `${dir}/Boxed.json`,
      `${dir}/Fine.json`,
      `${dir}/Fine.info`,
      `${dir}/Locked.json`,
    ]);
    const describe = (name: string): string =>
      changes.find((c) => c.path === `${dir}/${name}.json`)!.description;
    expect(describe('Boxed')).toBe(
      'Set its parent to "Generic PLA @BBL X2D" (was "Generic PLA @BBL X2D 0.6 nozzle"). ' +
        'Its sync file (.info) is a folder, not a file, so its base_id is left as it is.',
    );
    expect(describe('Locked')).toContain(
      "Its sync file (.info) couldn't be read (EBUSY: resource busy or locked), so its base_id",
    );
    expect(describe('Fine')).not.toContain('sync file');
  });

  it('leaves a sidecar that is not valid UTF-8 untouched but still re-parents the preset', async () => {
    const fs = fakeStudio(
      [
        {
          name: 'Generic PLA @BBL X2D',
          setting_id: 'GFSL99_20',
          compatible_printers: ['Bambu Lab X2D 0.6 nozzle'],
        },
      ],
      [{ name: 'Garbled', inherits: 'Generic PLA @BBL X2D 0.6 nozzle', info: sidecar('OLD') }],
    );
    const infoPath = 'user/1000000001/filament/Garbled.info';
    const bytes = Uint8Array.from([...new TextEncoder().encode('base_id = OLD\n'), 0xff, 0x0a]);
    await fs.writeBytes(infoPath, bytes);

    const r = await scan(fs);
    const changes = await planFixes(fs, r, defaultChoices(r));
    expect(changes.map((c) => c.path)).toEqual(['user/1000000001/filament/Garbled.json']);
    expect(changes[0]?.description).toContain(
      'Its sync file (.info) is not valid UTF-8 text, so its base_id is left as it is.',
    );
    expect(Array.from(await fs.readBytes(infoPath))).toEqual(Array.from(bytes));
  });

  it('never makes base_id equal to setting_id, which Studio treats as a broken sidecar', async () => {
    // Preset.cpp:1563 and GUI_App.cpp:6914-6917@v02.09.01.70 clear setting_id when the two match.
    const fs = fakeStudio(
      [
        {
          name: 'Generic PLA @BBL X2D',
          compatible_printers: ['Bambu Lab X2D 0.6 nozzle'],
          setting_id: 'GSAME',
        },
      ],
      [{ name: 'Odd', inherits: 'Generic PLA @BBL X2D 0.6 nozzle', info: sidecar('OLD', 'GSAME') }],
    );
    const r = await scan(fs);
    const changes = await planFixes(fs, r, defaultChoices(r));
    expect(changes.map((c) => c.path)).toEqual(['user/1000000001/filament/Odd.json']);
    expect(changes[0]?.description).toContain("setting_id is already the new parent's id");
  });

  it('changes only base_id in a sidecar, never sync_info or updated_time, and keeps "version"', async () => {
    // Studio drops a user preset without "version" (Preset.cpp:1491-1492@v02.09.01.70); a new
    // updated_time or sync_info would change how cloud sync treats it (SPEC section 10, question 3).
    const fs = fakeStudio(
      [
        {
          name: 'Generic PLA @BBL X2D',
          compatible_printers: ['Bambu Lab X2D 0.6 nozzle'],
          setting_id: 'GNEW',
        },
      ],
      [{ name: 'Mine', inherits: 'Generic PLA @BBL X2D 0.6 nozzle', info: sidecar('OLD') }],
    );
    const r = await scan(fs);
    const changes = await planFixes(fs, r, defaultChoices(r));
    const info = changes.find((c) => c.path.endsWith('.info'))!;
    expect(info.after).toBe(info.before.replace('base_id = OLD', 'base_id = GNEW'));
    const json = JSON.parse(changes.find((c) => c.path.endsWith('.json'))!.after);
    expect(json).toMatchObject({ inherits: 'Generic PLA @BBL X2D', version: '2.8.0.6' });
  });

  it('accepts any listed candidate, and combines edits to one file', async () => {
    const fs = fakeStudio(
      [
        { name: 'Generic PLA @BBL X2D', compatible_printers: ['Bambu Lab X2D 0.6 nozzle'] },
        {
          name: 'Generic PLA @BBL X2D 0.4 nozzle',
          compatible_printers: ['Bambu Lab X2D 0.4 nozzle'],
        },
      ],
      [
        {
          file: 'Mine',
          name: 'Mine old',
          inherits: 'Generic PLA @BBL X2D 0.6 nozzle',
          info: sidecar('OLD'),
        },
      ],
    );
    const r = await scan(fs);
    const path = 'user/1000000001/filament/Mine.json';
    const changes = await planFixes(fs, r, [
      { presetPath: path, candidateName: 'Generic PLA @BBL X2D 0.4 nozzle' },
      { presetPath: path, rename: true },
    ]);
    expect(changes.map((c) => c.path)).toEqual([path]);
    const after = JSON.parse(changes[0]!.after) as Record<string, unknown>;
    expect(after).toMatchObject({
      name: 'Mine',
      inherits: 'Generic PLA @BBL X2D 0.4 nozzle',
      filament_settings_id: ['Mine'],
    });
    // No setting_id on the fake system preset, so base_id stays.
    expect(changes[0]!.description).toBe(
      'Set its parent to "Generic PLA @BBL X2D 0.4 nozzle" (was "Generic PLA @BBL X2D 0.6 nozzle") and rename it from "Mine old" to "Mine".',
    );
  });

  it('refuses choices that do not match the scan', async () => {
    const fs = nodeFs(fixtureRoot('broken-r1'), { readOnly: true });
    const r = await scan(fs);
    const path = 'user/1000000001/filament/Anycubic Petg 06.json';
    await expect(planFixes(fs, r, [{ presetPath: path, candidateName: 'Nope' }])).rejects.toThrow(
      FixError,
    );
    await expect(planFixes(fs, r, [{ presetPath: path, rename: true }])).rejects.toThrow(
      'There is no rename',
    );
    await expect(planFixes(fs, r, [{ presetPath: 'user/x.json' }])).rejects.toThrow(
      'was not part of this scan',
    );
  });

  it('refuses to plan when the file changed after the scan', async () => {
    const fs = fakeStudio(
      [{ name: 'Generic PLA @BBL X2D', compatible_printers: ['Bambu Lab X2D 0.6 nozzle'] }],
      [{ name: 'Mine', inherits: 'Generic PLA @BBL X2D 0.6 nozzle' }],
    );
    const r = await scan(fs);
    const path = 'user/1000000001/filament/Mine.json';
    const text = await fs.readText(path);
    await fs.writeText(path, text.replace('X2D 0.6 nozzle', 'X2D 0.8 nozzle'));
    const err = await planFixes(fs, r, defaultChoices(r)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FixError);
    expect((err as FixError).stale).toBe(true);
  });

  it('plans an R2 retarget fix by updating inherits to the chosen parent and updating base_id', async () => {
    const presetPath = 'user/1000000001/filament/Bambu PLA Basic @BBL X1C - 60C bed temp.json';
    const infoPath = 'user/1000000001/filament/Bambu PLA Basic @BBL X1C - 60C bed temp.info';
    const fs = memFs({
      [presetPath]: JSON.stringify(
        {
          name: 'Bambu PLA Basic @BBL X1C - 60C bed temp',
          inherits: 'Bambu PLA Basic @BBL X1C',
          from: 'user',
        },
        null,
        2,
      ),
      [infoPath]: 'base_id = PFUS_OLD_X1C\nsetting_id = PFUS_USER_001\n',
    });

    const scanResult: ScanResult = {
      root: '',
      userId: '1000000001',
      accounts: [],
      presets: [
        {
          type: 'filament',
          accountId: '1000000001',
          path: presetPath,
          fileStem: 'Bambu PLA Basic @BBL X1C - 60C bed temp',
          name: 'Bambu PLA Basic @BBL X1C - 60C bed temp',
          inherits: 'Bambu PLA Basic @BBL X1C',
          isBase: false,
          status: 'unsupported',
          reason: "Only for printers you haven't added",
          ruleIds: [RULE_IDS.printerNotAdded],
        },
      ],
      findings: [
        {
          ruleId: RULE_IDS.printerNotAdded,
          severity: 'info',
          status: 'unsupported',
          presetPath,
          presetName: 'Bambu PLA Basic @BBL X1C - 60C bed temp',
          presetType: 'filament',
          title: "Only for printers you haven't added",
          explanation: 'It is made for Bambu Lab X1 Carbon.',
          proposedFix: {
            kind: 'setInherits',
            candidates: [
              {
                name: 'Bambu PLA Basic @BBL P1S 0.4 nozzle',
                confidence: 'high',
                reason: 'Switch parent to your added Bambu Lab P1S (0.4 mm)',
                source: 'system',
                settingId: 'PFUS_NEW_P1S',
                preselected: true,
                printerModel: 'Bambu Lab P1S',
              },
            ],
          },
        },
      ],
      warnings: [],
      systemVersion: '02.08.00.06',
      systemIndexRead: true,
      slicer: 'bambu',
      slicerVersion: null,
      countsByType: { filament: 1, process: 0, machine: 0 },
      indexesRead: { filament: true, process: true, machine: true },
      compat: {
        checked: true,
        enabled: [{ vendor: 'BBL', model: 'Bambu Lab P1S', nozzles: ['0.4'] }],
        userPrinters: 0,
        unsupportedGroup: 'shown',
      },
    };

    const changes = await planFixes(fs, scanResult, [
      {
        presetPath,
        candidateName: 'Bambu PLA Basic @BBL P1S 0.4 nozzle',
      },
    ]);

    expect(changes).toHaveLength(2);
    const jsonChange = changes.find((c) => c.path === presetPath);
    expect(jsonChange).toBeDefined();
    expect(jsonChange?.after).toContain('"inherits": "Bambu PLA Basic @BBL P1S 0.4 nozzle"');
    expect(jsonChange?.description).toContain(
      'Set its parent to "Bambu PLA Basic @BBL P1S 0.4 nozzle"',
    );

    const infoChange = changes.find((c) => c.path === infoPath);
    expect(infoChange).toBeDefined();
    expect(infoChange?.after).toContain('base_id = PFUS_NEW_P1S');
  });
});

describe('planFixes for process and printer presets', () => {
  it('types-bambu: re-parents processes, saying which printers, and renames with print_settings_id', async () => {
    const fs = nodeFs(fixtureRoot('types-bambu'), { readOnly: true });
    const r = await scan(fs);
    const changes = await planFixes(fs, r, defaultChoices(r));
    expect(changes.map((c) => c.path)).toEqual([
      'user/1000000001/process/Added Suffix.json',
      'user/1000000001/process/Case Only.json',
      'user/1000000001/process/Name Mismatch.json',
    ]);
    const [added, , renamed] = changes;
    expect(changedLines(added!.before, added!.after)).toEqual([
      [
        '    "inherits": "0.20mm Standard @BBL X2D 0.4 nozzle",',
        '    "inherits": "0.20mm Standard @BBL X2D",',
      ],
    ]);
    expect(added?.description).toBe(
      'Set its parent to "0.20mm Standard @BBL X2D" (was "0.20mm Standard @BBL X2D 0.4 nozzle"). ' +
        'The new parent decides which printers Studio offers this process for: Bambu Lab X2D 0.4 ' +
        'nozzle.',
    );
    expect(changedLines(renamed!.before, renamed!.after)).toEqual([
      ['    "name": "Name Mismatch Old",', '    "name": "Name Mismatch",'],
      [
        '    "print_settings_id": "Name Mismatch Old",',
        '    "print_settings_id": "Name Mismatch",',
      ],
    ]);
  });

  it('a printer preset is re-parented only onto the candidate the user picked', async () => {
    const fs = nodeFs(fixtureRoot('types-bambu'), { readOnly: true });
    const r = await scan(fs);
    const path = 'user/1000000001/machine/Case Only Printer.json';
    expect(defaultChoices(r).some((c) => c.presetPath === path)).toBe(false);
    const [change] = await planFixes(fs, r, [
      { presetPath: path, candidateName: 'Bambu Lab X1 Carbon 0.4 nozzle' },
    ]);
    expect(change?.path).toBe(path);
    expect(change?.after).toContain('"inherits": "Bambu Lab X1 Carbon 0.4 nozzle"');
    expect(change?.after).toContain('"printer_settings_id": "Case Only Printer"');
  });

  it('a filament and a process of the same name are not the same preset', async () => {
    const fs = fakeStudio(
      [
        { name: 'Generic PLA @BBL X1C', compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'] },
        {
          type: 'process',
          name: '0.20mm Standard @BBL X1C',
          compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'],
        },
      ],
      [
        { name: 'Shared', inherits: 'Generic PLA @BBL X1C' },
        {
          type: 'process',
          file: 'Shared (2)',
          name: 'Shared',
          inherits: '0.20mm Standard @BBL X1C',
        },
        { name: 'Orphan', inherits: 'Generic PLA @BBL X1C 0.4 nozzle' },
      ],
    );
    const r = await scan(fs);
    // Renaming the process "Shared" must not block a filament repair onto the filament "Shared".
    // R1 wouldn't offer that filament (it has a parent), so offer it by hand, as above.
    const orphan = r.findings.find(
      (f) => f.ruleId === R1_ID && f.presetPath === 'user/1000000001/filament/Orphan.json',
    )!;
    orphan.proposedFix = {
      kind: 'setInherits',
      candidates: [
        { name: 'Shared', confidence: 'high', reason: '', preselected: true, source: 'user' },
      ],
    };
    const changes = await planFixes(fs, r, [
      { presetPath: 'user/1000000001/filament/Orphan.json', candidateName: 'Shared' },
      { presetPath: 'user/1000000001/process/Shared (2).json', rename: true },
    ]);
    expect(changes.map((c) => c.path)).toEqual([
      'user/1000000001/filament/Orphan.json',
      'user/1000000001/process/Shared (2).json',
    ]);
    expect(changes[1]?.after).toContain('"print_settings_id": "Shared (2)"');
  });
});

describe('findStale', () => {
  it('lists planned files that changed or are gone, by bytes', async () => {
    const fs = memFs({ 'a.json': 'same', 'b.json': 'edited', 'c.json': 'same' });
    const change = (path: string): Change => ({
      path,
      before: 'same',
      after: 'x',
      description: '',
    });
    const changes = ['a.json', 'b.json', 'c.json', 'gone.json'].map(change);
    expect(await findStale(fs, changes)).toEqual(['b.json', 'gone.json']);
    expect(await findStale(fs, [change('a.json')])).toEqual([]);
  });

  it('rethrows read errors other than not-found', async () => {
    const fs = memFs({ 'a.json': 'same' });
    fs.readBytes = async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    };
    await expect(
      findStale(fs, [{ path: 'a.json', before: 'same', after: 'x', description: '' }]),
    ).rejects.toThrow('busy');
  });
});

describe('applyChanges', () => {
  it('fixes broken-r1 on a temp copy; a rescan finds only the presets without a sure fix', async () => {
    const dir = temp('broken-r1');
    const fs = nodeFs(dir);
    const r = await scan(fs);
    const changes = await planFixes(fs, r, defaultChoices(r));
    const { written } = await applyChanges(fs, changes);
    expect(written).toHaveLength(20);

    const again = await scan(fs);
    const left = again.findings.filter((f) => f.ruleId === R1_ID).map((f) => f.presetName);
    expect(left).toEqual([
      'Synthetic No Candidates',
      'Synthetic Other Printer Only',
      'Synthetic Stripped Suffix',
    ]);

    // Choosing by hand fixes the other two: the low-confidence candidate, and the 0.4 nozzle
    // preset for the one whose nozzle size is unsure (which also updates its base_id).
    const other = again.findings.find((f) => f.presetName === 'Synthetic Other Printer Only')!;
    const pick =
      other.proposedFix?.kind === 'setInherits' ? other.proposedFix.candidates[0] : undefined;
    const stripped = again.findings.find((f) => f.presetName === 'Synthetic Stripped Suffix')!;
    await applyChanges(
      fs,
      await planFixes(fs, again, [
        { presetPath: other.presetPath, candidateName: pick!.name },
        { presetPath: stripped.presetPath, candidateName: 'Bambu PLA Basic @BBL X2D 0.4 nozzle' },
      ]),
    );
    expect(
      readFileSync(join(dir, 'user/1000000001/filament/Synthetic Stripped Suffix.info'), 'utf8'),
    ).toBe(
      'sync_info = \r\nuser_id = 1000000001\r\nsetting_id = PFUSc12a29cdb2a4af\r\n' +
        'base_id = GFSA00_08\r\nupdated_time = 1782278409\r\n',
    );
    const last = (await scan(fs)).findings.filter((f) => f.ruleId === R1_ID);
    expect(last.map((f) => f.presetName)).toEqual(['Synthetic No Candidates']);
  });

  it('writes nothing if any file changed since planning', async () => {
    const dir = temp('broken-r1');
    const fs = nodeFs(dir);
    const r = await scan(fs);
    const changes = await planFixes(fs, r, defaultChoices(r));
    const victim = join(dir, 'user/1000000001/filament/Inland Petg 06.json');
    writeFileSync(victim, readFileSync(victim, 'utf8') + ' ');

    const err = await applyChanges(fs, changes).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleChangeError);
    expect((err as StaleChangeError).paths).toEqual([
      'user/1000000001/filament/Inland Petg 06.json',
    ]);
    for (const c of changes) {
      if (c.path.endsWith('Inland Petg 06.json')) continue;
      expect(await fs.readText(c.path)).toBe(c.before);
    }
  });

  it('refuses duplicate paths and reports writes that do not read back', async () => {
    const fs = memFs({ 'a.json': '{}' });
    const change: Change = { path: 'a.json', before: '{}', after: '{ }', description: '' };
    await expect(applyChanges(fs, [change, change])).rejects.toThrow('More than one change');

    const liar: PresetFs = { ...fs, writeText: async () => {} };
    const err = await applyChanges(liar, [change]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplyError);
    expect((err as ApplyError).written).toEqual([]);
  });

  it('lists a file as written when the write landed but reading it back failed', async () => {
    const fs = memFs({ 'a.json': '{}', 'b.json': '{}' });
    const changes: Change[] = ['a.json', 'b.json'].map((path) => ({
      path,
      before: '{}',
      after: '{ }',
      description: '',
    }));
    // Like an antivirus scanner locking b.json right after it was replaced.
    let locked = false;
    const flaky: PresetFs = {
      ...fs,
      writeText: async (path, data) => {
        await fs.writeText(path, data);
        if (path === 'b.json') locked = true;
      },
      readBytes: async (path) => {
        if (locked && path === 'b.json') {
          locked = false;
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        }
        return fs.readBytes(path);
      },
    };
    const err = await applyChanges(flaky, changes).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplyError);
    expect((err as ApplyError).message).toContain('EBUSY');
    expect((err as ApplyError).written).toEqual(['a.json', 'b.json']);
    expect(fs.snapshot()).toEqual({ 'a.json': '{ }', 'b.json': '{ }' });
  });

  it('refuses to write through a read-only adapter', async () => {
    const fs = nodeFs(fixtureRoot('broken-r1'), { readOnly: true });
    const r = await scan(fs);
    const changes = await planFixes(fs, r, defaultChoices(r));
    await expect(applyChanges(fs, changes)).rejects.toThrow(ApplyError);
  });
});
