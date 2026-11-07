import {
  BAMBU,
  ORCA,
  PRESET_TYPES,
  TERMS,
  type Finding,
  type PresetSummary,
  type ScanResult,
} from '@preset-doctor/core';
import { describe, expect, it } from 'vitest';
import {
  backupFitsFolder,
  choiceFor,
  compatLines,
  COMPAT_OTHER_QUERY,
  countByStatus,
  countByType,
  defaultTab,
  displayName,
  findingsByPath,
  fixesFor,
  forOtherSelection,
  initialSelection,
  isProblem,
  mergePaths,
  orderFindings,
  partialIndexText,
  PRESET_TYPE_ORDER,
  presetTabs,
  printersText,
  problemsByType,
  repairNotice,
  restoreNotice,
  selectedChoices,
  SLICER_TEXT,
  slicerOfRoot,
  TYPE_TERMS,
  unreadIndexTypes,
  visiblePresets,
  windowsPath,
} from './model';

const preset = (path: string, status: PresetSummary['status'], name?: string): PresetSummary => ({
  type: 'filament',
  accountId: '1000000001',
  path,
  fileStem: path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/i, ''),
  ...(name ? { name } : {}),
  isBase: false,
  status,
  reason: '',
  ruleIds: [],
});

const orphan: Finding = {
  ruleId: 'R1_ORPHANED_PARENT',
  severity: 'error',
  presetPath: 'a.json',
  status: 'hidden',
  title: 'Parent preset is missing',
  explanation: '',
  proposedFix: {
    kind: 'setInherits',
    candidates: [
      { name: 'High', confidence: 'high', reason: '', preselected: true },
      { name: 'Low', confidence: 'low', reason: '', preselected: false },
    ],
  },
};
const lowOnly: Finding = {
  ...orphan,
  presetPath: 'b.json',
  proposedFix: {
    kind: 'setInherits',
    candidates: [{ name: 'Low', confidence: 'low', reason: '', preselected: false }],
  },
};
const rename: Finding = {
  ruleId: 'R4_MALFORMED',
  severity: 'warning',
  presetPath: 'c.json',
  status: 'info',
  title: 'Name mismatch',
  explanation: '',
  proposedFix: { kind: 'renamePreset', newName: 'c' },
};
const note: Finding = { ...rename, presetPath: 'd.json', severity: 'info', title: 'No sync file' };
delete (note as { proposedFix?: unknown }).proposedFix;

const scan: ScanResult = {
  root: 'X',
  userId: '1000000001',
  accounts: [{ id: '1000000001', presetCount: 5, byType: { filament: 5, process: 0, machine: 0 } }],
  presets: [
    preset('e.json', 'ok', 'Echo'),
    preset('d.json', 'info', 'delta'),
    preset('c.json', 'info', 'c.json'),
    preset('b.json', 'hidden', 'Bravo'),
    preset('a.json', 'hidden', 'Alpha'),
  ],
  findings: [orphan, lowOnly, rename, note],
  warnings: [],
  systemVersion: '1',
  systemIndexRead: true,
  slicer: 'bambu',
  slicerVersion: null,
  countsByType: { filament: 5, process: 0, machine: 0 },
  indexesRead: { filament: true, process: true, machine: true },
  compat: {
    checked: false,
    why: 'no-printers',
    enabled: [],
    userPrinters: 0,
    unsupportedGroup: 'shown',
  },
};
const byPath = findingsByPath(scan);

describe('renderer model', () => {
  it('needs-attention filter keeps hidden, broken and fixable rows, sorted', () => {
    expect(visiblePresets(scan, byPath, 'problems', '').map((p) => p.path)).toEqual([
      'a.json',
      'b.json',
      'c.json',
    ]);
    expect(visiblePresets(scan, byPath, 'all', '')).toHaveLength(5);
    expect(visiblePresets(scan, byPath, 'all', 'DEL').map((p) => p.path)).toEqual(['d.json']);
    expect(isProblem(scan.presets[1]!, byPath)).toBe(false);
  });

  it('starts from the default picks and only sends complete choices', () => {
    const sel = initialSelection([
      { presetPath: 'a.json', candidateName: 'High' },
      { presetPath: 'c.json', rename: true },
    ]);
    expect(selectedChoices(scan, byPath, sel)).toEqual([
      { presetPath: 'c.json', rename: true },
      { presetPath: 'a.json', candidateName: 'High' },
    ]);
    // Ticking a row with no pick yet sends nothing for it.
    sel.checked['b.json'] = true;
    expect(selectedChoices(scan, byPath, sel)).toHaveLength(2);
    sel.picks['b.json'] = 'Low';
    expect(selectedChoices(scan, byPath, sel)).toContainEqual({
      presetPath: 'b.json',
      candidateName: 'Low',
    });
  });

  it('ignores a pick that is not one of the candidates', () => {
    expect(choiceFor('a.json', fixesFor([orphan]), { 'a.json': 'Nope' })).toBeNull();
  });

  it('lists fixable findings first', () => {
    expect(orderFindings([note, rename]).map((f) => f.title)).toEqual([
      'Name mismatch',
      'No sync file',
    ]);
  });
});

describe('preset type tabs', () => {
  const typed = (p: PresetSummary, type: PresetSummary['type']): PresetSummary => ({ ...p, type });
  const mixed: ScanResult = {
    ...scan,
    presets: [
      ...scan.presets.filter((p) => p.status === 'ok'),
      typed(preset('p1.json', 'ok', 'Proc ok'), 'process'),
      typed(preset('a.json', 'hidden', 'Alpha'), 'machine'),
    ],
    findings: [orphan],
    countsByType: { filament: 1, process: 1, machine: 1 },
  };
  const mixedByPath = findingsByPath(mixed);

  it('a filament-only scan has one tab, so no tab bar is shown', () => {
    expect(presetTabs(scan)).toEqual(['filament']);
    expect(defaultTab(scan, byPath)).toBe('filament');
  });

  it('counts rows and problems per type, and opens the first tab with a problem', () => {
    expect(countByType(mixed)).toEqual({ filament: 1, process: 1, machine: 1 });
    expect(problemsByType(mixed, mixedByPath)).toEqual({ filament: 0, process: 0, machine: 1 });
    expect(presetTabs(mixed)).toEqual(['filament', 'process', 'machine']);
    expect(defaultTab(mixed, mixedByPath)).toBe('machine');
    const calm = { ...mixed, presets: mixed.presets.filter((p) => p.status === 'ok') };
    expect(defaultTab(calm, findingsByPath(calm))).toBe('filament');
    expect(defaultTab({ ...scan, presets: [] }, new Map())).toBe('filament');
  });

  it('filters rows by tab', () => {
    expect(visiblePresets(mixed, mixedByPath, 'all', '', 'process').map((p) => p.path)).toEqual([
      'p1.json',
    ]);
    expect(visiblePresets(mixed, mixedByPath, 'problems', '', 'filament')).toEqual([]);
    expect(visiblePresets(mixed, mixedByPath, 'all', '')).toHaveLength(3);
  });
});

describe('result banners', () => {
  const desktop = {
    web: false,
    cloud: false,
    backupsDir: 'C:/Users/x/AppData/Roaming/PresetDoctor/backups',
  };
  const web = { web: true, cloud: false, backupsDir: 'preset-doctor-backups' };
  const applied = (written: string[], backupIsNew: boolean) => ({
    written,
    backup: { id: '2026-11-05T17-30-00' },
    backupIsNew,
  });

  it('counts repaired presets, not sync files, and says where the backup is', () => {
    const one = repairNotice(applied(['a.json', 'a.info'], true), desktop);
    expect(one.title).toBe('Repaired 1 preset.');
    expect(one.lines).toEqual([
      'Your presets were backed up first (backup 2026-11-05T17-30-00).',
      'Next: open Bambu Studio and check that your presets are back. If anything looks wrong, use "Restore a backup".',
    ]);
    const two = repairNotice(applied(['a.json', 'b.json'], false), web);
    expect(two.title).toBe('Repaired 2 presets.');
    expect(two.lines[0]).toBe(
      'Your presets were already backed up earlier in this session (backup 2026-11-05T17-30-00, in the preset-doctor-backups folder).',
    );
    expect(two.lines[1]).toMatch(/^Next: copy the repaired files back into Bambu Studio/);
  });

  it('adds the cloud-sync line only when sync is on', () => {
    const lines = repairNotice(applied(['a.json'], true), { ...desktop, cloud: true }).lines;
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/^Cloud sync is on/);
  });

  it('tells the web user to copy the restored folder back', () => {
    expect(restoreNotice('2026-11-05T17-30-00', 4, false)).toEqual({
      title: 'Restored backup 2026-11-05T17-30-00.',
      lines: ['4 files were put back. The state before the restore was backed up too.'],
    });
    expect(restoreNotice('2026-11-05T17-30-00', 4, true).lines[1]).toBe(
      'Copy the user folder back into Bambu Studio to finish (see below).',
    );
  });
});

describe('displayName', () => {
  it('uses the name, else the file stem core worked out', () => {
    expect(displayName(preset('user/1/filament/A.json', 'ok', 'Alpha'))).toBe('Alpha');
    expect(displayName({ ...preset('user/1/filament/B.JSON', 'broken'), fileStem: 'B' })).toBe('B');
  });
});

describe('changed-file lists (web copy-back)', () => {
  it('shows paths the Windows way', () => {
    expect(windowsPath('user/1000000001/filament/A b.json')).toBe(
      'user\\1000000001\\filament\\A b.json',
    );
  });

  it('merges without duplicates, sorted', () => {
    expect(mergePaths(['user/b.json', 'user/a.json'], ['user/a.json', 'user/a.info'])).toEqual([
      'user/a.info',
      'user/a.json',
      'user/b.json',
    ]);
  });
});

describe('printer checks (R2/R3)', () => {
  const unsupported: PresetSummary = {
    ...preset('u.json', 'unsupported', 'Uniform'),
    compat: {
      state: 'printer-not-added',
      printers: ['Bambu Lab H2D 0.4 nozzle'],
      source: { kind: 'own' },
    },
  };
  const elsewhere: PresetSummary = {
    ...preset('o.json', 'ok', 'Oscar'),
    compat: {
      state: 'other-printer',
      printers: ['Bambu Lab P1S 0.4 nozzle'],
      matchedPrinters: ['Bambu Lab P1S 0.4 nozzle'],
      source: { kind: 'inherited', from: 'Generic PLA @BBL P1S' },
    },
  };
  const r2: Finding = {
    ruleId: 'R2_PRINTER_NOT_ADDED',
    severity: 'info',
    presetPath: 'u.json',
    status: 'unsupported',
    title: "Only for printers you haven't added",
    explanation: '',
  };
  const sidecarNote: Finding = { ...note, presetPath: 'u.json' };
  const withCompat: ScanResult = {
    ...scan,
    presets: [...scan.presets, unsupported, elsewhere],
    findings: [...scan.findings, sidecarNote, r2],
  };
  const map = findingsByPath(withCompat);

  it('counts unsupported rows as needing attention, after hidden and broken', () => {
    expect(isProblem(unsupported, map)).toBe(true);
    expect(isProblem(elsewhere, map)).toBe(false);
    expect(visiblePresets(withCompat, map, 'problems', '').map((p) => p.path)).toEqual([
      'a.json',
      'b.json',
      'u.json',
      'c.json',
    ]);
    expect(countByStatus(withCompat).unsupported).toBe(1);
    expect(countByStatus(scan).unsupported).toBe(0);
  });

  it('puts the R2 finding before an R4 note of the same severity', () => {
    expect(orderFindings(map.get('u.json')!).map((f) => f.ruleId)).toEqual([
      'R2_PRINTER_NOT_ADDED',
      'R4_MALFORMED',
    ]);
  });

  it('lists exactly the rows of the grouped note for its search text', () => {
    expect(visiblePresets(withCompat, map, 'all', COMPAT_OTHER_QUERY).map((p) => p.path)).toEqual([
      'o.json',
    ]);
    expect(forOtherSelection(withCompat).map((p) => p.path)).toEqual(['o.json']);
  });

  it('describes the added printers, or why the checks were skipped', () => {
    expect(
      printersText(
        {
          checked: true,
          selectedPrinter: 'Bambu Lab X2D 0.4 nozzle',
          enabled: [
            { vendor: 'BBL', model: 'Bambu Lab X2D', nozzles: ['0.4', '0.6'] },
            { vendor: 'BBL', model: 'Bambu Lab P1S', nozzles: ['0.4'] },
          ],
          userPrinters: 1,
          unsupportedGroup: 'shown',
        },
        'Bambu Studio',
      ),
    ).toBe(
      'Printers added in Bambu Studio: X2D (0.4, 0.6 mm) · P1S (0.4 mm) · 1 printer preset of ' +
        'your own. Selected: X2D 0.4 nozzle.',
    );
    expect(printersText(scan.compat, 'Bambu Studio')).toBe(
      "Printer checks skipped: Bambu Studio's settings don't list the printers you've added.",
    );
  });

  it('explains where the printer list comes from', () => {
    expect(compatLines(elsewhere.compat!, 'Bambu Studio')).toEqual([
      'Offered for: Bambu Lab P1S 0.4 nozzle.',
      'This list comes from "Generic PLA @BBL P1S", the preset it is based on.',
      'Bambu Studio shows it when you select Bambu Lab P1S 0.4 nozzle.',
    ]);
  });

  it("never says 'every printer' when it can't tell", () => {
    const opaque = compatLines(
      { state: 'cant-tell', why: 'opaque', printers: [], source: { kind: 'default' } },
      'OrcaSlicer',
    );
    expect(opaque.join(' ')).not.toContain('every printer');
    expect(opaque.join(' ')).toContain("can't tell which printers it is for");
    const rule = compatLines(
      { state: 'cant-tell', why: 'condition', printers: [], source: { kind: 'own' } },
      'OrcaSlicer',
    );
    expect(rule.join(' ')).not.toContain('every printer');
    expect(rule.join(' ')).toContain("Preset Doctor can't evaluate it");
    expect(
      compatLines({ state: 'all', printers: [], source: { kind: 'own' } }, 'Bambu Studio')[0],
    ).toBe('Offered for: every printer.');
    expect(
      compatLines(
        { state: 'other-vendor', vendor: 'BBL', printers: [], source: { kind: 'own' } },
        'Bambu Studio',
      )[0],
    ).toBe('Offered for: every printer of the BBL brand profile it is based on.');
  });
});

describe("the UI's copies of core values", () => {
  it('match core (model.ts imports only types from core)', () => {
    expect([...PRESET_TYPE_ORDER]).toEqual([...PRESET_TYPES]);
    for (const t of PRESET_TYPES) {
      expect(TYPE_TERMS[t]).toEqual({
        tab: TERMS[t].tab,
        noun: TERMS[t].noun,
        baseTag: TERMS[t].baseTag,
      });
    }
    expect(SLICER_TEXT.bambu.name).toBe(BAMBU.displayName);
    expect(SLICER_TEXT.orca.name).toBe(ORCA.displayName);
    expect(SLICER_TEXT.bambu.conf).toBe(BAMBU.confFile);
    expect(SLICER_TEXT.orca.conf).toBe(ORCA.confFile);
    expect(SLICER_TEXT.bambu.dirName).toBe(BAMBU.rootDirName);
    expect(SLICER_TEXT.orca.dirName).toBe(ORCA.rootDirName);
  });
});

describe('the incomplete-results banner', () => {
  it('names only the types whose system presets could not be read', () => {
    const scan = { indexesRead: { filament: true, process: false, machine: true } } as ScanResult;
    expect(unreadIndexTypes(scan)).toEqual(['process']);
    expect(partialIndexText(['process'], 'Bambu Studio')).toBe(
      "Preset Doctor couldn't read Bambu Studio's system process presets, so your process " +
        "presets weren't checked against them. Everything else was checked.",
    );
    expect(partialIndexText(['process', 'machine'], 'OrcaSlicer')).toContain(
      'system process and printer presets',
    );
    expect(partialIndexText([], 'Bambu Studio')).toBeNull();
    expect(partialIndexText(['filament', 'process', 'machine'], 'Bambu Studio')).toBeNull();
  });
});

describe('slicer of the shown folder', () => {
  const slicers = [
    { id: 'bambu' as const, root: 'C:\\Users\\you\\AppData\\Roaming\\BambuStudio' },
    { id: 'orca' as const, root: 'C:\\Users\\you\\AppData\\Roaming\\OrcaSlicer' },
  ];

  it('is known only for a default folder: a picked copy presses no slicer switch', () => {
    expect(slicerOfRoot(slicers, 'c:\\users\\you\\appdata\\roaming\\orcaslicer\\')).toBe('orca');
    expect(slicerOfRoot(slicers, 'D:\\OrcaCopy')).toBeUndefined();
    expect(slicerOfRoot([], 'PresetDoctor-copy')).toBeUndefined();
  });

  it('offers every backup for restore until the slicer is known', () => {
    const orcaBackup = { slicer: 'orca' as const };
    // Web after a reload: no scan yet, and the fallback slicer is Bambu Studio.
    expect(backupFitsFolder(orcaBackup, 'bambu', false)).toBe(true);
    expect(backupFitsFolder(orcaBackup, 'bambu', true)).toBe(false);
    expect(backupFitsFolder(orcaBackup, 'orca', true)).toBe(true);
  });
});
