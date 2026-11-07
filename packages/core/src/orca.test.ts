import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BackupSlicerError, createBackup, listBackups, restoreBackup } from './backup.js';
import { main } from './cli.js';
import { parseStudioConf } from './conf.js';
import { defaultChoices, planFixes } from './fix.js';
import { encodeText } from './fs.js';
import { memFs } from './memFs.js';
import { defaultPaths, isSlicerRunning, isStudioRunning } from './node/studioProcess.js';
import { nodeFs } from './node/nodeFs.js';
import { cerealStrings, makeOpc, opcHasString, readOpc } from './opc.js';
import { derivedRenamedFrom, genericFallbackName } from './orcaLookup.js';
import { R1_ID } from './rules/r1.js';
import type { RuleContext } from './rules/context.js';
import { orcaMissingFinding } from './rules/r1Orca.js';
import { compatFinding, R2_ID, R3_NOTE_ID } from './rules/r2r3.js';
import { scan, ScanError } from './scan.js';
import { BAMBU, detectSlicer, ORCA, SLICERS } from './slicer.js';
import { loadSystemIndexSet, splitEscaped } from './systemIndex.js';
import { fixtureRoot } from './testing/fixtures.js';
import { tempFixture } from './testing/studio.js';
import type { Finding, ScanResult } from './types.js';

const orcaFixture = () => nodeFs(fixtureRoot('orca'), { readOnly: true });
const byName = (r: ScanResult, name: string) => r.presets.find((p) => p.name === name);
const findingsOf = (r: ScanResult, name: string): Finding[] =>
  r.findings.filter((f) => f.presetName === name);
const r1Of = (r: ScanResult, name: string) => findingsOf(r, name).find((f) => f.ruleId === R1_ID);
const candidates = (f: Finding | undefined) =>
  f?.proposedFix?.kind === 'setInherits'
    ? f.proposedFix.candidates.map((c) => [c.name, c.confidence, c.preselected])
    : [];

/** A minimal OrcaSlicer folder: vendor indexes built from preset bodies. */
function orcaFs(
  vendors: Record<string, Record<string, Record<string, unknown>>>,
  extra: Record<string, string | Uint8Array> = {},
) {
  const files: Record<string, string | Uint8Array> = {
    'OrcaSlicer.conf': '{"app":{"sync_user_preset":false},"header":"OrcaSlicer 2.5.0"}\n',
    ...extra,
  };
  for (const [vendor, presets] of Object.entries(vendors)) {
    const lists: Record<string, { name: string; sub_path: string }[]> = {
      filament_list: [],
      process_list: [],
      machine_list: [],
    };
    for (const [name, body] of Object.entries(presets)) {
      const type = (body['type'] as string | undefined) ?? 'filament';
      const sub = `${type}/${name}.json`;
      lists[
        `${type === 'process' ? 'process' : type === 'machine' ? 'machine' : 'filament'}_list`
      ]!.push({
        name,
        sub_path: sub,
      });
      files[`system/${vendor}/${sub}`] = JSON.stringify({ name, ...body }, null, 4);
    }
    files[`system/${vendor}.json`] = JSON.stringify({
      name: vendor,
      version: '02.05.00.00',
      ...lists,
    });
  }
  return memFs(files);
}

const user = (name: string, inherits: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ from: 'User', inherits, name, version: '2.5.0.0', ...extra }, null, 4);
const inst = { instantiation: 'true' };

describe('detectSlicer', () => {
  const detect = async (paths: string[]) =>
    detectSlicer(memFs(Object.fromEntries(paths.map((p) => [p, '{}']))));

  it('refuses a folder with both confs', async () => {
    expect(await detect(['BambuStudio.conf', 'OrcaSlicer.conf'])).toMatchObject({
      ok: false,
      reason: 'both',
    });
  });

  it('follows the rules in order', async () => {
    expect(await detect(['OrcaSlicer.conf', 'system/BBL.json'])).toMatchObject({ profile: ORCA });
    expect(await detect(['BambuStudio.conf', 'system/OrcaFilamentLibrary.json'])).toMatchObject({
      profile: BAMBU,
    });
    // Orca installs BBL.json too, so its library is checked first.
    expect(await detect(['system/OrcaFilamentLibrary.json', 'system/BBL.json'])).toMatchObject({
      profile: ORCA,
    });
    expect(await detect(['system/OrcaFilamentLibrary.opc'])).toMatchObject({ profile: ORCA });
    expect(await detect(['system/BBL.json'])).toMatchObject({ profile: BAMBU });
    const legacy = await detect(['user/1000000001/filament/a.json']);
    expect(legacy).toMatchObject({ ok: true, profile: BAMBU });
    expect(legacy.ok && legacy.evidence).toMatch(/Only a user folder/);
    expect(await detect(['readme.txt'])).toMatchObject({ ok: false, reason: 'neither' });
  });

  it('scan turns a failed detection into a ScanError', async () => {
    const both = memFs({ 'BambuStudio.conf': '{}', 'OrcaSlicer.conf': '{}' });
    await expect(scan(both)).rejects.toThrow(/both Bambu Studio and OrcaSlicer/);
    await expect(scan(memFs({ 'a.txt': '' }), { root: 'X:\\Folder' })).rejects.toThrow(
      /^X:\\Folder doesn't look like a Bambu Studio or OrcaSlicer data folder/,
    );
    await expect(scan(memFs({}))).rejects.toBeInstanceOf(ScanError);
  });
});

describe('OrcaSlicer profile', () => {
  it('lists both slicers', () => {
    expect(SLICERS).toEqual([BAMBU, ORCA]);
    expect(ORCA.processNames).toContain('orca-slicer');
    expect(ORCA.vendorCheck).toBe(false);
    expect(ORCA.loneInfoIsCloudDelete).toBe(true);
  });

  it('loads the library first, then the other vendors sorted, and .opc-only vendors apart', () => {
    const f = (name: string) => ({ name, kind: 'file' as const });
    const plan = ORCA.vendorOrder([
      f('Elegoo.json'),
      f('custom.json'),
      f('OrcaFilamentLibrary.json'),
      f('BBL.opc'),
      f('Elegoo.opc'),
      { name: 'Elegoo', kind: 'dir' },
    ]);
    expect(plan).toEqual({
      json: ['OrcaFilamentLibrary', 'custom', 'Elegoo'],
      opc: ['BBL'],
      base: 'OrcaFilamentLibrary',
      required: 'OrcaFilamentLibrary',
    });
    expect(ORCA.vendorOrder([f('Elegoo.json')])).toEqual({ json: ['Elegoo'], opc: [] });
  });

  it('reads the version from the header and hides the Unsupported group from 2.4 on', () => {
    const conf = (header?: string, show?: boolean) => ({
      found: true,
      ...(header !== undefined ? { header } : {}),
      ...(show !== undefined ? { showUnsupportedPresets: show } : {}),
    });
    expect(ORCA.versionFrom(conf('OrcaSlicer 2.3.2-rc'))).toBe('2.3.2-rc');
    expect(ORCA.versionFrom(conf())).toBeNull();
    expect(ORCA.unsupportedGroup(conf('OrcaSlicer 2.3.2-rc'))).toBe('shown');
    expect(ORCA.unsupportedGroup(conf('OrcaSlicer 2.4.0'))).toBe('hidden-by-setting');
    expect(ORCA.unsupportedGroup(conf('OrcaSlicer 2.5.0', true))).toBe('shown');
    expect(ORCA.unsupportedGroup(conf())).toBe('hidden-by-setting');
    expect(BAMBU.unsupportedGroup(conf())).toBe('shown');
  });

  it('rewords Studio texts but never a quoted preset name', () => {
    expect(
      ORCA.reword(
        'Based on "Bambu Studio PLA", which Bambu Studio hides. Studio\'s list; Bambu\'s current preset.',
      ),
    ).toBe(
      'Based on "Bambu Studio PLA", which OrcaSlicer hides. OrcaSlicer\'s list; OrcaSlicer\'s current preset.',
    );
    expect(BAMBU.reword('Studio')).toBe('Studio');
  });

  it('names the clouds in the R5 text', () => {
    const text = ORCA.cloudSyncText({ found: true, cloudProviders: ['orca', 'bbl'] });
    expect(text.title).toBe('Cloud preset sync is on');
    expect(text.explanation).toMatch(
      /^OrcaSlicer syncs your presets with Orca Cloud and the Bambu cloud\. /,
    );
    expect(text.explanation).not.toMatch(/Studio/);
  });
});

describe('OrcaSlicer "Show unsupported presets" hint', () => {
  const finding = (type: 'filament' | 'process') =>
    compatFinding(
      {
        path: `user/default/${type}/Mine.json`,
        name: 'Mine',
        type,
        detail: {
          state: 'printer-not-added',
          printers: ['Bambu Lab H2D 0.4 nozzle'],
          source: { kind: 'own' },
        },
        context: {
          checked: true,
          enabled: [],
          userPrinters: 0,
          unsupportedGroup: 'hidden-by-setting',
        },
      },
      ORCA,
    );

  it('is given for filaments only: the setting does not reach the process list', () => {
    expect(finding('filament')?.explanation).toContain('Show unsupported presets');
    const proc = finding('process')?.explanation ?? '';
    expect(proc).not.toContain('Show unsupported presets');
    expect(proc).toContain("doesn't offer it in the process list for any printer you've added");
  });
});

describe('OrcaSlicer.conf', () => {
  it('reads the Orca keys and the per-printer process', () => {
    const conf = parseStudioConf(
      JSON.stringify({
        app: {
          sync_user_preset: true,
          cloud_providers: 'orca;bbl',
          show_unsupported_presets: false,
          preset_folder: '',
        },
        header: 'OrcaSlicer 2.5.0',
        presets: { machine: 'P 0.4 nozzle', filaments: null },
        orca_presets: [
          { machine: 'Other', process: 'Nope' },
          { machine: 'P 0.4 nozzle', process: '0.20mm Standard @P' },
        ],
      }) + '\n# MD5 checksum 00\n',
      'OrcaSlicer.conf',
    );
    expect(conf).toMatchObject({
      syncUserPreset: true,
      header: 'OrcaSlicer 2.5.0',
      cloudProviders: ['orca', 'bbl'],
      showUnsupportedPresets: false,
      presetFolder: '',
      selectedPrinter: 'P 0.4 nozzle',
      selectedProcess: '0.20mm Standard @P',
    });
    expect(parseStudioConf('{', 'OrcaSlicer.conf').error).toMatch(/^OrcaSlicer\.conf is not valid/);
  });
});

describe('orca/ fixture', () => {
  it('scans as OrcaSlicer 2.3.2-rc, account "default" first', async () => {
    const r = await scan(orcaFixture());
    expect(r.slicer).toBe('orca');
    expect(r.slicerVersion).toBe('2.3.2-rc');
    expect(r.systemVersion).toBe('02.03.02.50');
    expect(r.warnings).toEqual([]);
    expect(r.userId).toBe('default');
    expect(r.accounts.map((a) => [a.id, a.presetCount])).toEqual([
      ['default', 10],
      ['1000000001', 1],
    ]);
    expect(r.compat).toMatchObject({
      checked: true,
      unsupportedGroup: 'shown',
      selectedPrinter: 'Elegoo Centauri Carbon 0.4 nozzle',
      selectedProcess: '0.20mm Standard @Elegoo CC 0.4 nozzle',
    });
  });

  it('gives every row the status in the fixture README', async () => {
    const r = await scan(orcaFixture());
    const status = Object.fromEntries(r.presets.map((p) => [p.name, p.status]));
    expect(status).toEqual({
      'Lib Child': 'ok',
      'Toolchanger Child': 'unsupported',
      Renamed: 'unsupported',
      'Generic Fallback': 'info',
      'Case Only': 'hidden',
      'Brand Off': 'hidden',
      'Library Gone': 'hidden',
      'CC Copy': 'ok',
      'CC 06 Copy': 'ok',
      'My CC': 'ok',
    });
    expect(byName(r, 'CC Copy')?.compat?.state).toBe('selected');
    expect(byName(r, 'CC 06 Copy')?.compat?.state).toBe('other-printer');
    expect(byName(r, 'Lib Child')?.compat?.state).toBe('all');
    // The Custom parent inherits the library: its own list still decides.
    expect(byName(r, 'Toolchanger Child')?.compat).toMatchObject({
      state: 'printer-not-added',
      source: { kind: 'inherited', from: 'Generic PLA @MyToolChanger' },
    });
    expect(r.findings.find((f) => f.ruleId === R3_NOTE_ID)?.explanation).toMatch(
      /^1 process preset is made for another printer/,
    );
  });

  it('finds a renamed parent, and offers the new name without pre-selecting it', async () => {
    const r = await scan(orcaFixture());
    const f = r1Of(r, 'Renamed');
    expect(f).toMatchObject({
      status: 'info',
      severity: 'info',
      title: 'Parent found under its new name',
    });
    expect(f?.explanation).toContain('which OrcaSlicer now calls "Generic ABS @MyToolChanger"');
    expect(candidates(f)).toEqual([['Generic ABS @MyToolChanger', 'high', false]]);
    // R2 still judges it, through the parent under its new name.
    expect(byName(r, 'Renamed')?.compat?.source).toEqual({
      kind: 'inherited',
      from: 'Generic ABS @MyToolChanger',
    });
    expect(findingsOf(r, 'Renamed').some((f) => f.ruleId === R2_ID)).toBe(true);
  });

  it('notes the "Generic" fallback', async () => {
    const r = await scan(orcaFixture());
    const f = r1Of(r, 'Generic Fallback');
    expect(f).toMatchObject({ status: 'info', title: 'OrcaSlicer substitutes a generic parent' });
    expect(f?.explanation).toContain('falls back to "Generic PLA @System"');
    expect(candidates(f).every((c) => c[2] === false)).toBe(true);
  });

  it('pre-selects a case-only rename, and never pre-selects with the brand hint', async () => {
    const r = await scan(orcaFixture());
    expect(candidates(r1Of(r, 'Case Only'))).toEqual([['Elegoo PLA @ECC', 'high', true]]);
    const brand = r1Of(r, 'Brand Off');
    expect(brand?.status).toBe('hidden');
    expect(brand?.explanation).toContain('If you turned off the Creality printers');
    expect(r1Of(r, 'Library Gone')?.explanation).not.toContain('turned off');
    expect(r1Of(r, 'Library Gone')?.explanation).toContain(
      "no longer exists in OrcaSlicer's system presets (version 02.03.02.50), so OrcaSlicer hides it",
    );
    // Texts name OrcaSlicer; Bambu Studio only where it is meant.
    for (const f of r.findings) {
      expect(`${f.title} ${f.explanation}`).not.toMatch(/(?<!Bambu )Studio/);
    }
  });

  it('scans the second account (ids are strings, any account folder)', async () => {
    const r = await scan(orcaFixture(), { userId: '1000000001' });
    expect(r.presets.map((p) => [p.name, p.status])).toEqual([['Plain', 'ok']]);
  });

  it('plans the pre-selected repair, and the renamed one when picked', async () => {
    const fs = orcaFixture();
    const r = await scan(fs);
    const changes = await planFixes(fs, r, defaultChoices(r));
    // The sidecar's base_id already names the new parent, so only the preset changes.
    expect(changes.map((c) => c.path)).toEqual(['user/default/filament/Case Only.json']);
    const renamed = await planFixes(fs, r, [
      {
        presetPath: 'user/default/filament/Renamed.json',
        candidateName: 'Generic ABS @MyToolChanger',
      },
    ]);
    expect(renamed[0]?.after).toContain('"inherits": "Generic ABS @MyToolChanger"');
  });

  it('CLI: prints the slicer line, and --slicer picks the default folder', async () => {
    const out: string[] = [];
    const deps = {
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => out.push(t),
      paths: { studioRoot: 'Z:\\nope', orcaRoot: fixtureRoot('orca'), backupsDir: 'Z:\\b' },
      isStudioRunning: async () => false,
    };
    expect(await main(['scan', '--slicer', 'orca'], deps)).toBe(1);
    const text = out.join('');
    expect(text).toContain('Slicer:  OrcaSlicer 2.3.2-rc\n');
    expect(text).toContain('Hidden in OrcaSlicer (3)');
    out.length = 0;
    expect(await main(['scan', fixtureRoot('orca'), '--slicer', 'bambu'], deps)).toBe(2);
    expect(out.join('')).toMatch(/is an OrcaSlicer folder, not a Bambu Studio folder/);
    out.length = 0;
    expect(await main(['scan', '--slicer', 'prusa'], deps)).toBe(2);
  });
});

describe('OrcaSlicer parent lookup', () => {
  it('rewrites "Generic" names like find_preset2', () => {
    expect(genericFallbackName('Generic PLA @Elegoo CC')).toBe('Generic PLA @System');
    expect(genericFallbackName('Bambu_Generic PETG HF @BBL X1C')).toBe('Generic PETG HF @System');
    expect(genericFallbackName('My PLA @X')).toBe('My PLA @X');
    expect(derivedRenamedFrom('Bambu PLA Basic @BBL X2D')).toBe('Bambu PLA Basic BBL X2D');
    expect(derivedRenamedFrom('fdm_filament_pla')).toBeUndefined();
  });

  it('splits renamed_from like unescape_strings_cstyle', () => {
    expect(splitEscaped('A @X;B @Y')).toEqual(['A @X', 'B @Y']);
    expect(splitEscaped(' "A;B" ; C ')).toEqual(['A;B', 'C ']);
    expect(splitEscaped('"a\\"b"')).toEqual(['a"b']);
    expect(splitEscaped('')).toEqual([]);
  });

  const renames = (header: string) =>
    orcaFs(
      {
        OrcaFilamentLibrary: {
          fdm_filament_pla: { instantiation: 'false', compatible_printers: [] },
          'C @System': { inherits: 'fdm_filament_pla', renamed_from: 'B @System', ...inst },
          'B2 @System': { inherits: 'fdm_filament_pla', renamed_from: 'A @System', ...inst },
        },
      },
      {
        'OrcaSlicer.conf': JSON.stringify({ app: {}, header }),
        // A -> B2 is one step; Z -> B -> C would need two, but B is not a preset name.
        'user/default/filament/One.json': user('One', 'A @System'),
        'user/default/filament/Derived.json': user('Derived', 'C System'),
      },
    );

  it('follows renamed_from and the derived old name', async () => {
    const r = await scan(renames('OrcaSlicer 2.5.0'));
    expect(r1Of(r, 'One')?.title).toBe('Parent found under its new name');
    expect(candidates(r1Of(r, 'One'))).toEqual([['B2 @System', 'high', false]]);
    // No renamed_from of its own would derive "C System"; this one has one, so nothing is derived.
    expect(r1Of(r, 'Derived')?.status).toBe('hidden');
  });

  it('follows renames recursively from 2.5, one step before', async () => {
    const vendors = {
      OrcaFilamentLibrary: {
        'New @System': { renamed_from: 'Mid @System', ...inst },
        'Mid2 @System': { renamed_from: 'Old @System', instantiation: 'false' },
      },
    };
    // Old -> Mid2 (a template, not a parent) stops; Old2 -> Mid -> New needs two steps.
    const extra = (header: string) => ({
      'OrcaSlicer.conf': JSON.stringify({ app: {}, header }),
      'system/OrcaFilamentLibrary/filament/Mid @System.json': '{}',
      'user/default/filament/Two.json': user('Two', 'Mid @System'),
    });
    const r = await scan(orcaFs(vendors, extra('OrcaSlicer 2.3.2')));
    expect(r1Of(r, 'Two')?.title).toBe('Parent found under its new name');
  });

  it("prefers the user's own preset over any fallback", async () => {
    const r = await scan(
      orcaFs(
        { OrcaFilamentLibrary: { 'Generic PLA @System': inst } },
        {
          'user/default/filament/base/Generic PLA @Mine.json': user('Generic PLA @Mine', ''),
          'user/default/filament/Child.json': user('Child', 'Generic PLA @Mine'),
        },
      ),
    );
    expect(findingsOf(r, 'Child').filter((f) => f.ruleId === R1_ID)).toEqual([]);
  });

  it('lets system presets inherit the library, and only from their own vendor or it', async () => {
    const fs = orcaFs({
      OrcaFilamentLibrary: {
        'Lib PLA @base': { instantiation: 'false', compatible_printers: ['P 0.4 nozzle'] },
      },
      Elegoo: {
        'Lib PLA @E': { inherits: 'Lib PLA @base', ...inst },
        'Other @E': { inherits: 'Only In Custom', ...inst },
      },
      Custom: { 'Only In Custom': { compatible_printers: ['Q 0.4 nozzle'], ...inst } },
    });
    const set = await loadSystemIndexSet(fs, ORCA);
    const f = set.byType.filament!;
    expect(await f.effectiveCompatiblePrinters('Lib PLA @E')).toEqual(['P 0.4 nozzle']);
    // Custom is neither Elegoo nor the library: Orca can't find that parent either.
    expect(await f.effectiveCompatiblePrinters('Other @E')).toBeNull();
    expect(set.vendors).toEqual(['OrcaFilamentLibrary', 'Custom', 'Elegoo']);
  });

  it('treats a bundle preset as an existing parent of unknown settings', async () => {
    const r = await scan(
      orcaFs(
        { OrcaFilamentLibrary: { 'Generic PLA @System': inst } },
        {
          'user/default/_local/abc/filament/Shared PLA.json': user(
            'Shared PLA',
            'Generic PLA @System',
          ),
          'user/default/filament/Child.json': user('Child', '_local/abc/Shared PLA'),
          'user/default/filament/Lost.json': user('Lost', '_local/abc/Gone'),
        },
      ),
    );
    expect(r.presets.map((p) => p.name).sort()).toEqual(['Child', 'Lost']);
    expect(r1Of(r, 'Child')).toBeUndefined();
    expect(byName(r, 'Lost')?.status).toBe('hidden');
  });
});

describe('OrcaSlicer vendor indexes that fail to load', () => {
  it('a broken library stops the parent check: nothing is called missing', async () => {
    const { dir, cleanup } = tempFixture('orca');
    try {
      const path = join(dir, 'system', 'OrcaFilamentLibrary.json');
      const text = readFileSync(path);
      writeFileSync(path, text.subarray(0, text.length - 20));
      for (const userId of ['default', '1000000001']) {
        const r = await scan(nodeFs(dir, { readOnly: true }), { userId });
        expect(r.indexesRead.filament).toBe(false);
        expect(r.presets.some((p) => p.status === 'hidden')).toBe(false);
        expect(r.findings.some((f) => f.ruleId === R1_ID && f.status === 'hidden')).toBe(false);
        expect(
          r.findings.some(
            (f) =>
              f.proposedFix?.kind === 'setInherits' &&
              f.proposedFix.candidates.some((c) => c.preselected),
          ),
        ).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

  it('another broken vendor: a parent that is not found "could not be checked"', async () => {
    const fs = orcaFs(
      {
        OrcaFilamentLibrary: { 'Generic PLA @System': inst },
        Elegoo: { 'Elegoo PLA @ECC': inst },
      },
      { 'user/default/filament/Mine.json': user('Mine', 'Elegoo PLA Pro @ECC') },
    );
    await fs.writeText('system/Elegoo.json', '{"name": "Elegoo", "filament_li');
    const r = await scan(fs);
    expect(
      r.warnings.some((w) => w.includes("Presets based on Elegoo system presets can't be checked")),
    ).toBe(true);
    expect(r1Of(r, 'Mine')).toMatchObject({ status: 'info', title: 'Parent could not be checked' });
    // The reason is the broken vendor, not the .opc format (there is no .opc file here).
    expect(r1Of(r, 'Mine')?.explanation).toMatch(
      /^Preset Doctor couldn't read OrcaSlicer's system presets from Elegoo, so it can't tell whether "Elegoo PLA Pro @ECC" still exists/,
    );
    expect(r1Of(r, 'Mine')?.explanation).not.toContain('packed format');
    expect(byName(r, 'Mine')?.status).toBe('info');
  });
});

describe('OrcaSlicer before 2.3', () => {
  it('finds parents by their exact name only: no renamed_from, no "Generic" fallback', async () => {
    const vendors = {
      OrcaFilamentLibrary: {
        'Generic PLA @System': inst,
        'New PLA @System': { renamed_from: 'Old PLA @System', ...inst },
      },
    };
    const extra = (header: string) => ({
      'OrcaSlicer.conf': JSON.stringify({ app: {}, header }),
      'user/default/filament/Renamed.json': user('Renamed', 'Old PLA @System'),
      'user/default/filament/Generic.json': user('Generic', 'Generic PLA @Gone'),
    });
    const old = await scan(orcaFs(vendors, extra('OrcaSlicer 2.2.0')));
    expect(byName(old, 'Renamed')?.status).toBe('hidden');
    expect(byName(old, 'Generic')?.status).toBe('hidden');
    const now = await scan(orcaFs(vendors, extra('OrcaSlicer 2.3.0')));
    expect(r1Of(now, 'Renamed')?.title).toBe('Parent found under its new name');
    expect(r1Of(now, 'Generic')?.title).toBe('OrcaSlicer substitutes a generic parent');
  });
});

describe('OrcaSlicer brand hint', () => {
  it('takes back a base_id pre-selection among several high candidates, wording included', () => {
    const cand = (name: string, preselected: boolean) => ({
      name,
      confidence: 'high' as const,
      reason: 'r',
      preselected,
      source: 'system' as const,
    });
    // The sentence r1.ts writes for this case (pinned in r1.test.ts too).
    const f: Finding = {
      ruleId: R1_ID,
      severity: 'error',
      presetPath: 'user/default/filament/Mine.json',
      presetName: 'Mine',
      status: 'hidden',
      title: 'Parent preset is missing',
      explanation:
        'This preset is based on "Baz @Gone K1 0.60 nozzle", which no longer exists. 2 presets ' +
        'look like good replacements; "Baz @Gone K1 0.6 nozzle" is pre-selected because your ' +
        "preset's sync file (.info) names it.",
      proposedFix: {
        kind: 'setInherits',
        candidates: [cand('Baz @Gone K1', false), cand('Baz @Gone K1 0.6 nozzle', true)],
      },
    };
    const ctx = {
      profile: ORCA,
      system: { names: () => [] },
      orca: { unchecked: false, vendors: ['OrcaFilamentLibrary'] },
    } as unknown as RuleContext;
    const out = orcaMissingFinding(f, 'Baz @Gone K1 0.60 nozzle', ctx);
    expect(out.explanation).toContain('If you turned off the Gone printers');
    expect(out.explanation).not.toContain('is pre-selected');
    expect(out.explanation).toContain(
      '"Baz @Gone K1 0.6 nozzle" is the one your preset\'s sync file (.info) names',
    );
    expect(
      out.proposedFix?.kind === 'setInherits' &&
        out.proposedFix.candidates.some((c) => c.preselected),
    ).toBe(false);
  });
});

describe('OrcaSlicer 2.5 packed presets (.opc)', () => {
  const body = cerealStrings([
    'BBL',
    '02.05.00.00',
    'Bambu PLA Basic @BBL X1C',
    'fdm_filament_pla',
  ]);

  it('checks the header, size and CRC, and finds cereal strings', () => {
    const opc = makeOpc(body);
    const read = readOpc(opc);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(opcHasString(read.body, 'Bambu PLA Basic @BBL X1C')).toBe(true);
    // A substring of a stored string is not a stored string.
    expect(opcHasString(read.body, 'Bambu PLA Basic')).toBe(false);
    const bad = opc.slice();
    bad[bad.length - 1] = (bad.at(-1) ?? 0) ^ 0xff;
    expect(readOpc(bad).ok).toBe(false);
    expect(readOpc(opc.slice(0, 19)).ok).toBe(false);
    expect(readOpc(encodeText('{"not":"opc"}')).ok).toBe(false);
  });

  const opcFolder = (opc: Uint8Array) =>
    memFs({
      'OrcaSlicer.conf': '{"app":{},"header":"OrcaSlicer 2.5.0"}',
      'system/OrcaFilamentLibrary.opc': opc,
      'user/default/filament/Known.json': user('Known', 'Bambu PLA Basic @BBL X1C'),
      'user/default/filament/Unknown.json': user('Unknown', 'Gone PLA @BBL X1C'),
    });

  it('a .opc-only system/: found parents are OK, the rest "could not be checked", never hidden', async () => {
    const r = await scan(opcFolder(makeOpc(body)));
    expect(r.slicer).toBe('orca');
    expect(r1Of(r, 'Known')).toBeUndefined();
    const unknown = r1Of(r, 'Unknown');
    expect(unknown).toMatchObject({
      status: 'info',
      severity: 'info',
      title: 'Parent could not be checked',
    });
    expect(unknown?.proposedFix).toBeUndefined();
    expect(r.warnings).toContain(
      "OrcaSlicer's built-in presets for OrcaFilamentLibrary are in its packed format; Preset " +
        'Doctor checks only that parents exist and suggests no replacements for them.',
    );
  });

  it('an unreadable .opc: nothing is called missing', async () => {
    const r = await scan(opcFolder(encodeText('garbage')));
    expect(byName(r, 'Known')?.status).toBe('info');
    expect(byName(r, 'Unknown')?.status).toBe('info');
    expect(r.presets.some((p) => p.status === 'hidden')).toBe(false);
  });
});

describe('backups and restore across slicers', () => {
  const USER = {
    'user/default/filament/A.json': '{"name":"A"}',
    'user/default/filament/A.info': 'sync_info = \r\n',
    'user/default/filament/Lone.info': 'sync_info = delete\r\nsetting_id = PFUS1\r\n',
  };

  it("tags backups with the slicer and refuses the other slicer's folder", async () => {
    const src = memFs(USER);
    const dest = memFs();
    const b = await createBackup(src, dest, { slicer: 'orca', sourceRoot: 'C:\\O' });
    expect(b.slicer).toBe('orca');
    expect((await listBackups(dest))[0]?.slicer).toBe('orca');
    await expect(
      restoreBackup(src, dest, b.id, { slicer: 'bambu', allowOtherSource: true }),
    ).rejects.toBeInstanceOf(BackupSlicerError);
    // Older backups say nothing: they are Bambu Studio backups.
    const old = await createBackup(memFs(USER), dest, { now: new Date(2020, 0, 1) });
    expect(old.slicer).toBe('bambu');
    await expect(restoreBackup(src, dest, old.id, { slicer: 'orca' })).rejects.toThrow(
      /made from a Bambu Studio folder, and this is an OrcaSlicer folder/,
    );
  });

  it('writes presets before sync files, and never puts back a lone .info for OrcaSlicer', async () => {
    const dest = memFs();
    const b = await createBackup(memFs(USER), dest, { slicer: 'orca' });
    const target = memFs({});
    const writes: string[] = [];
    const spy = {
      ...target,
      writeBytes: async (p: string, d: Uint8Array) => {
        writes.push(p);
        return target.writeBytes(p, d);
      },
    };
    const res = await restoreBackup(spy, dest, b.id, { slicer: 'orca' });
    expect(res.skipped).toEqual(['user/default/filament/Lone.info']);
    expect(writes).toEqual(['user/default/filament/A.json', 'user/default/filament/A.info']);
    expect(await target.exists('user/default/filament/Lone.info')).toBe(false);

    // Bambu Studio has no such rule: the sync file goes back as it was.
    const bambuDest = memFs();
    const bb = await createBackup(memFs(USER), bambuDest);
    const bambuTarget = memFs({});
    expect((await restoreBackup(bambuTarget, bambuDest, bb.id)).skipped).toEqual([]);
    expect(await bambuTarget.exists('user/default/filament/Lone.info')).toBe(true);
  });

  it("skips a sync file when it can't tell whether its preset is on disk", async () => {
    const dest = memFs();
    const b = await createBackup(memFs(USER), dest, { slicer: 'orca' });
    const target = memFs({ 'user/default/filament/Lone.json': '{"name":"Lone"}' });
    const doubtful = {
      ...target,
      exists: async (p: string) => {
        if (p.endsWith('Lone.json')) throw new Error('access denied');
        return target.exists(p);
      },
    };
    const res = await restoreBackup(doubtful, dest, b.id, { slicer: 'orca' });
    expect(res.skipped).toEqual(['user/default/filament/Lone.info']);
    expect(await target.exists('user/default/filament/Lone.info')).toBe(false);
  });

  it('puts a lone .info back when its preset exists on disk now', async () => {
    const dest = memFs();
    const b = await createBackup(memFs(USER), dest, { slicer: 'orca' });
    const target = memFs({ 'user/default/filament/Lone.json': '{"name":"Lone"}' });
    const res = await restoreBackup(target, dest, b.id, { slicer: 'orca' });
    expect(res.skipped).toEqual([]);
    expect(await target.exists('user/default/filament/Lone.info')).toBe(true);
  });

  it("backs up the Orca fixture's whole user folder, lone .info included, not user_backup-*", async () => {
    const t = tempFixture('orca');
    const backups = mkdtempSync(join(tmpdir(), 'preset-doctor-backups-'));
    try {
      const b = await createBackup(nodeFs(t.dir), nodeFs(backups), { slicer: 'orca' });
      expect(b.fileCount).toBe(
        readdirSync(join(t.dir, 'user'), { recursive: true }).filter((p) =>
          /\.(json|info|cereal)$/.test(String(p)),
        ).length,
      );
      const res = await restoreBackup(nodeFs(t.dir), nodeFs(backups), b.id, { slicer: 'orca' });
      expect(res.skipped).toEqual(['user/default/filament/Lone.info']);
      expect(existsSync(join(t.dir, 'user', 'default', 'filament', 'Lone.info'))).toBe(true);
    } finally {
      t.cleanup();
      rmSync(backups, { recursive: true, force: true });
    }
  });
});

describe('OrcaSlicer running check', () => {
  const list =
    (...names: string[]) =>
    async () =>
      names.map((n) => `"${n}","1","Console","1","1 K"`).join('\r\n');

  it('looks for orca-slicer.exe, and keeps the Studio check as it was', async () => {
    const opts = (run: () => Promise<string>) => ({ platform: 'win32' as const, run, env: {} });
    expect(await isSlicerRunning(ORCA, opts(list('System', 'orca-slicer.exe')))).toBe(true);
    expect(await isSlicerRunning(ORCA, opts(list('System', 'bambu-studio.exe')))).toBe(false);
    expect(await isStudioRunning(opts(list('System', 'orca-slicer.exe')))).toBe(false);
    expect(await isSlicerRunning(BAMBU, opts(list('System', 'bambu-studio.exe')))).toBe(true);
  });

  it('knows the default OrcaSlicer folder', () => {
    expect(defaultPaths({ platform: 'win32', env: { APPDATA: 'C:\\R' } }).orcaRoot).toBe(
      'C:\\R\\OrcaSlicer',
    );
  });
});

// Read-only check against the real install: npm run test:live -- orca
describe.runIf(process.env['PRESET_DOCTOR_LIVE'] === '1')(
  'live OrcaSlicer folder (read-only)',
  () => {
    const live = defaultPaths().orcaRoot;
    it.runIf(existsSync(join(live, 'OrcaSlicer.conf')))(
      'scans a temp copy without errors',
      async () => {
        const parent = mkdtempSync(join(tmpdir(), 'preset-doctor-orca-live-'));
        const dir = join(parent, 'OrcaSlicer');
        try {
          // Only what a scan reads; the copy is deleted at the end.
          for (const item of ['OrcaSlicer.conf', 'system', 'user']) {
            if (existsSync(join(live, item)))
              cpSync(join(live, item), join(dir, item), { recursive: true });
          }
          const r = await scan(nodeFs(dir, { readOnly: true }));
          expect(r.slicer).toBe('orca');
          expect(r.systemIndexRead).toBe(true);
          // This machine's install when this was written (docs/design-v0.2.md section 9, step 3):
          // OrcaSlicer 2.3.2-rc with no presets of its own. Update both when that changes.
          expect(r.slicerVersion).toBe('2.3.2-rc');
          expect(r.presets).toEqual([]);
          expect(r.warnings).toEqual([]);
        } finally {
          rmSync(parent, { recursive: true, force: true });
        }
      },
    );
  },
);
