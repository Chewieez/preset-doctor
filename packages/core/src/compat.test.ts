import { describe, expect, it } from 'vitest';
import { judgeCompat, type CompatInputs, type EffectiveCompat, type PrinterRef } from './compat.js';
import { nodeFs } from './node/nodeFs.js';
import { defaultPaths } from './node/studioProcess.js';
import { FAMILY_NOTE_ID, familyCopiesFinding, R2_ID, R3_ID, R3_NOTE_ID } from './rules/r2r3.js';
import { ORCA } from './slicer.js';
import { scan } from './scan.js';
import { FIXTURE_NAMES, fixtureRoot } from './testing/fixtures.js';
import { fakeStudio, type FakeSystemPreset, type FakeUserPreset } from './testing/studio.js';
import type { CompatDetail, PresetSummary, ScanResult } from './types.js';

const X2D = (n: string) => `Bambu Lab X2D ${n} nozzle`;
const P1S = 'Bambu Lab P1S 0.4 nozzle';
const H2D = 'Bambu Lab H2D 0.4 nozzle';

const TRAILER = '# MD5 checksum 00000000000000000000000000000000\n';
function conf(sections: Record<string, unknown>): string {
  return (
    JSON.stringify({ app: { sync_user_preset: false }, ...sections }, null, 4) + '\n' + TRAILER
  );
}
const MODELS = [
  { vendor: 'BBL', model: 'Bambu Lab X2D', nozzle_diameter: '0.4;0.6' },
  { vendor: 'BBL', model: 'Bambu Lab P1S', nozzle_diameter: '0.4' },
];
const PRESETS = { machine: X2D('0.4'), process: '0.20mm Standard @BBL X2D' };

const machine = (name: string, model: string, variant: string): FakeSystemPreset => ({
  type: 'machine',
  name,
  inherits: 'fdm_machine_common',
  extra: { printer_model: model, printer_variant: variant },
});

const SYSTEM: FakeSystemPreset[] = [
  { type: 'machine', name: 'fdm_machine_common', instantiation: 'false', extra: { type: null } },
  machine(X2D('0.4'), 'Bambu Lab X2D', '0.4'),
  machine(X2D('0.6'), 'Bambu Lab X2D', '0.6'),
  machine(X2D('0.8'), 'Bambu Lab X2D', '0.8'),
  machine(P1S, 'Bambu Lab P1S', '0.4'),
  machine(H2D, 'Bambu Lab H2D', '0.4'),
  { type: 'process', name: 'fdm_process_common', instantiation: 'false' },
  {
    type: 'process',
    name: '0.20mm Standard @BBL X2D',
    inherits: 'fdm_process_common',
    compatible_printers: [X2D('0.4')],
  },
  {
    type: 'process',
    name: '0.20mm Standard @BBL H2D',
    inherits: 'fdm_process_common',
    compatible_printers: [H2D],
  },
  { name: 'fdm_filament_common', instantiation: 'false', compatible_printers: [] },
  { name: 'Generic PLA @base', inherits: 'fdm_filament_common', instantiation: 'false' },
  {
    name: 'Generic PLA @BBL X2D 0.4 nozzle',
    inherits: 'Generic PLA @base',
    compatible_printers: [X2D('0.4')],
  },
  {
    name: 'Generic PLA @BBL X2D 0.8 nozzle',
    inherits: 'Generic PLA @base',
    compatible_printers: [X2D('0.8')],
  },
  { name: 'Generic PLA @BBL H2D', inherits: 'Generic PLA @base', compatible_printers: [H2D] },
  { name: 'Generic PLA @BBL P1S', inherits: 'Generic PLA @base', compatible_printers: [P1S] },
];

async function scanWith(
  user: FakeUserPreset[],
  sections: Record<string, unknown> = { models: MODELS, presets: PRESETS },
): Promise<ScanResult> {
  return scan(fakeStudio(SYSTEM, user, { conf: conf(sections) }));
}

function row(r: ScanResult, name: string): PresetSummary {
  const p = r.presets.find((x) => x.name === name);
  if (!p) throw new Error(`no row ${name}`);
  return p;
}

const fil = (name: string, inherits: string, extra?: Record<string, unknown>): FakeUserPreset => ({
  name,
  inherits,
  ...(extra ? { extra } : {}),
});

describe('effective compatibility through the parent chain', () => {
  it('uses the nearest system ancestor when the user file has no list', async () => {
    const r = await scanWith([fil('Mine', 'Generic PLA @BBL X2D 0.4 nozzle')]);
    expect(row(r, 'Mine').compat).toMatchObject({
      state: 'selected',
      printers: [X2D('0.4')],
      source: { kind: 'inherited', from: 'Generic PLA @BBL X2D 0.4 nozzle' },
    });
  });

  it("lets the file's own list win, even over a user parent's", async () => {
    const r = await scanWith([
      fil('Parent', 'Generic PLA @BBL X2D 0.4 nozzle', { compatible_printers: [P1S] }),
      fil('Child', 'Parent'),
      fil('Own', 'Parent', { compatible_printers: [H2D] }),
    ]);
    expect(row(r, 'Parent').compat).toMatchObject({
      state: 'other-printer',
      source: { kind: 'own' },
    });
    expect(row(r, 'Child').compat).toMatchObject({
      state: 'other-printer',
      matchedPrinters: [P1S],
      source: { kind: 'inherited', from: 'Parent' },
    });
    expect(row(r, 'Own').compat).toMatchObject({ state: 'printer-not-added' });
  });

  it('treats an own empty list as "every printer", not as unset', async () => {
    const r = await scanWith([fil('Open', 'Generic PLA @BBL H2D', { compatible_printers: [] })]);
    expect(row(r, 'Open').compat).toMatchObject({ state: 'all', printers: [] });
    // 'info' only for the missing sync file.
    expect(row(r, 'Open').status).toBe('info');
  });

  it('applies the custom filament name rule', async () => {
    const r = await scanWith([
      { name: 'Wizard @Bambu Lab H2D 0.4 nozzle', base: true, extra: { compatible_printers: [] } },
      { name: 'No At Sign', base: true, extra: { compatible_printers: [] } },
    ]);
    expect(row(r, 'Wizard @Bambu Lab H2D 0.4 nozzle').compat).toMatchObject({
      state: 'printer-not-added',
      printers: [H2D],
      source: { kind: 'name' },
    });
    expect(row(r, 'No At Sign').compat).toMatchObject({ state: 'all' });
  });

  it("passes the name rule on to a custom filament's children that set no list", async () => {
    const r = await scanWith([
      { name: 'Root @Bambu Lab H2D 0.4 nozzle', base: true, extra: { compatible_printers: [] } },
      fil('Child', 'Root @Bambu Lab H2D 0.4 nozzle'),
      fil('Own Open', 'Root @Bambu Lab H2D 0.4 nozzle', { compatible_printers: [] }),
    ]);
    expect(row(r, 'Child').compat).toMatchObject({
      state: 'printer-not-added',
      printers: [H2D],
      source: { kind: 'inherited', from: 'Root @Bambu Lab H2D 0.4 nozzle' },
    });
    // Its own empty list wins, as the child's file sets it.
    expect(row(r, 'Own Open').compat).toMatchObject({ state: 'all', printers: [] });
  });

  it("sends a filament for one of the user's hidden printers to that printer's repair", async () => {
    const r = await scanWith([
      { type: 'machine', name: 'My Old X2D', inherits: 'Bambu Lab X2D 0.5 nozzle' },
      fil('For Old X2D', 'Generic PLA @BBL X2D 0.4 nozzle', {
        compatible_printers: ['My Old X2D'],
      }),
    ]);
    expect(row(r, 'My Old X2D').status).toBe('hidden');
    const f = r.findings.find((x) => x.presetName === 'For Old X2D' && x.ruleId === R2_ID);
    expect(row(r, 'For Old X2D')).toMatchObject({
      status: 'unsupported',
      compat: { state: 'printer-hidden', hiddenPrinters: ['My Old X2D'] },
      reason: 'Made for your printer preset "My Old X2D", which can\'t load',
    });
    expect(f?.explanation).toContain("which Studio can't load right now");
    expect(f?.explanation).toContain('Repair that printer preset');
    expect(f?.explanation).not.toContain('copy the settings');
  });

  it('reports a condition without evaluating it', async () => {
    const r = await scanWith([
      fil('Cond', 'Generic PLA @BBL H2D', {
        compatible_printers: [],
        compatible_printers_condition: 'nozzle_diameter[0]==0.4',
      }),
    ]);
    expect(row(r, 'Cond').compat).toMatchObject({ state: 'cant-tell', why: 'condition' });
    expect(row(r, 'Cond').status).toBe('info');
    expect(r.findings.filter((f) => f.presetPath === row(r, 'Cond').path)).toEqual([
      expect.objectContaining({ ruleId: 'R4_MALFORMED' }),
    ]);
  });
});

describe('R2/R3 verdicts', () => {
  it('R2 for a printer that is not added, R3 for a nozzle that is not added', async () => {
    const r = await scanWith([
      fil('For H2D', 'Generic PLA @BBL H2D'),
      fil('For X2D 08', 'Generic PLA @BBL X2D 0.8 nozzle'),
    ]);
    const h2d = row(r, 'For H2D');
    expect(h2d.status).toBe('unsupported');
    expect(h2d.reason).toBe(`Only for printers you haven't added (${H2D})`);
    expect(h2d.ruleIds).toContain(R2_ID);
    const x2d = row(r, 'For X2D 08');
    expect(x2d.compat).toMatchObject({
      state: 'nozzle-not-added',
      model: 'Bambu Lab X2D',
      nozzles: ['0.8'],
      addedNozzles: ['0.4', '0.6'],
    });
    expect(x2d.reason).toBe("Made for the 0.8 mm nozzle, which you haven't added");
    const f = r.findings.find((x) => x.ruleId === R3_ID)!;
    expect(f).toMatchObject({ severity: 'info', status: 'unsupported', presetType: 'filament' });
    expect(f.proposedFix).toBeUndefined();
    expect(f.explanation).toContain('add the 0.8 mm nozzle for that printer');
  });

  it('never judges printer presets, and counts loaded user printers as added', async () => {
    const r = await scanWith([
      { type: 'machine', name: 'My H2D', inherits: H2D },
      fil('For H2D', 'Generic PLA @BBL H2D'),
      fil('For My H2D', 'Generic PLA @BBL X2D 0.4 nozzle', { compatible_printers: ['My H2D'] }),
    ]);
    expect(row(r, 'My H2D').compat).toBeUndefined();
    expect(r.compat.userPrinters).toBe(1);
    // The user printer's direct parent is in the list: Studio shows it for that printer.
    expect(row(r, 'For H2D').compat).toMatchObject({
      state: 'other-printer',
      matchedPrinters: ['My H2D'],
    });
    expect(row(r, 'For My H2D').compat).toMatchObject({ state: 'other-printer' });
  });

  it('checks only the direct parent of a user printer, as Studio does', async () => {
    const r = await scanWith([
      { type: 'machine', name: 'Base H2D', inherits: H2D },
      { type: 'machine', name: 'Grandchild H2D', inherits: 'Base H2D' },
      fil('For H2D', 'Generic PLA @BBL H2D'),
    ]);
    // Base H2D matches; Grandchild H2D would not on its own (its parent is "Base H2D").
    expect(row(r, 'For H2D').compat?.matchedPrinters).toEqual(['Base H2D']);
    const only = await scanWith([
      { type: 'machine', name: 'Grandchild H2D', inherits: 'Base H2D' },
      { type: 'machine', name: 'Base H2D', inherits: H2D, extra: { instantiation: 'false' } },
      fil('For H2D', 'Generic PLA @BBL H2D'),
    ]);
    expect(row(only, 'For H2D').compat?.state).toBe('printer-not-added');
  });

  it('applies the vendor check: a BBL-based preset is not offered for a root user printer', async () => {
    const r = await scanWith([
      { type: 'machine', name: 'Wizard Printer', base: true, extra: { printer_model: 'Mine' } },
      fil('For Wizard', 'Generic PLA @BBL X2D 0.4 nozzle', {
        compatible_printers: ['Wizard Printer'],
      }),
      { name: 'Root For Wizard', base: true, extra: { compatible_printers: ['Wizard Printer'] } },
    ]);
    expect(row(r, 'For Wizard').compat).toMatchObject({
      state: 'other-vendor',
      vendor: 'BBL',
      matchedPrinters: ['Wizard Printer'],
    });
    expect(row(r, 'For Wizard').status).toBe('unsupported');
    // A preset without a system ancestor has no vendor, so the check doesn't apply.
    expect(row(r, 'Root For Wizard').compat?.state).toBe('other-printer');
  });

  it('lists unknown printer names, reading the model from the name', async () => {
    const r = await scanWith([
      fil('Gone', 'Generic PLA @BBL H2D', { compatible_printers: ['Bambu Lab Q9 0.4 nozzle'] }),
      fil('Mixed', 'Generic PLA @BBL H2D', {
        compatible_printers: [H2D, 'Bambu Lab Q9 0.4 nozzle'],
      }),
      fil('Odd', 'Generic PLA @BBL H2D', { compatible_printers: ['Bambu Lab X2D 0.3 nozzle'] }),
    ]);
    expect(row(r, 'Gone').compat).toMatchObject({
      state: 'unknown-printers',
      unknownNames: ['Bambu Lab Q9 0.4 nozzle'],
      guessed: true,
    });
    expect(row(r, 'Gone').reason).toBe("Lists printers Studio doesn't know");
    expect(row(r, 'Mixed').compat).toMatchObject({
      state: 'printer-not-added',
      unknownNames: ['Bambu Lab Q9 0.4 nozzle'],
    });
    // An unknown name of an added model: R3, marked as read from the name.
    expect(row(r, 'Odd').compat).toMatchObject({ state: 'nozzle-not-added', guessed: true });
    const odd = r.findings.find((f) => f.presetName === 'Odd' && f.ruleId === R3_ID);
    expect(odd?.explanation).toContain("(Preset Doctor read this from the printer's name)");
  });

  it('judges a process preset and words it for the process list', async () => {
    const r = await scanWith([
      { type: 'process', name: 'Proc H2D', inherits: '0.20mm Standard @BBL H2D' },
      { type: 'process', name: 'Proc X2D', inherits: '0.20mm Standard @BBL X2D' },
    ]);
    expect(row(r, 'Proc X2D').compat?.state).toBe('selected');
    const f = r.findings.find((x) => x.presetName === 'Proc H2D' && x.ruleId === R2_ID);
    expect(f?.explanation).toContain("doesn't offer it in the process list");
    expect(f?.explanation).not.toContain('Unsupported presets');
  });

  it('skips presets that Studio does not load or never shows', async () => {
    const r = await scanWith([
      fil('Orphan', 'Generic PLA @BBL Z9'),
      fil('Orphan child', 'Orphan'),
      fil('Invisible', 'Generic PLA @BBL H2D', { instantiation: 'false' }),
    ]);
    for (const n of ['Orphan', 'Orphan child', 'Invisible']) {
      expect(row(r, n).compat).toBeUndefined();
    }
    expect(r.findings.some((f) => f.ruleId === R2_ID)).toBe(false);
  });

  it("words the vendor check for a preset with no printer list (no 'fits its list')", async () => {
    const r = await scanWith(
      [
        { type: 'machine', name: 'Wizard Printer', base: true, extra: { printer_model: 'Mine' } },
        fil('Open', 'Generic PLA @BBL H2D', { compatible_printers: [] }),
      ],
      { models: [], presets: { machine: 'Wizard Printer' } },
    );
    expect(row(r, 'Open').compat).toMatchObject({ state: 'other-vendor', printers: [] });
    const f = r.findings.find((x) => x.presetName === 'Open' && x.ruleId === R2_ID)!;
    expect(f.explanation).toContain('has no printer list of its own');
    expect(f.explanation).toContain("None of the printers you've added uses one");
    expect(f.explanation).not.toContain('fit its list');
  });
});

/** A custom filament as "Create filament" makes it: no parent, its printer in its name. */
const custom = (name: string, extra: Record<string, unknown> = {}): FakeUserPreset => ({
  name,
  base: true,
  extra: { compatible_printers: [], ...extra },
});

describe('copies of a custom filament (one name in Studio)', () => {
  it('turns a copy into a note when another copy is offered for an added printer', async () => {
    const r = await scanWith([
      custom(`Fam @${X2D('0.4')}`),
      custom(`Fam @${P1S}`),
      custom(`Fam @${H2D}`),
      custom(`Fam @${X2D('0.8')}`),
      custom(`Solo @${H2D}`),
    ]);
    const h2d = row(r, `Fam @${H2D}`);
    expect(h2d.status).toBe('info');
    expect(h2d.compat).toMatchObject({
      state: 'printer-not-added',
      family: { alias: 'Fam', copy: `Fam @${X2D('0.4')}`, copyState: 'selected' },
    });
    expect(h2d.reason).toBe(`Copy of "Fam": only for printers you haven't added (${H2D})`);
    // The nozzle copy (R3) is a copy too; the P1S copy is for an added printer, so not one.
    expect(row(r, `Fam @${X2D('0.8')}`)).toMatchObject({
      status: 'info',
      compat: { state: 'nozzle-not-added', family: { alias: 'Fam' } },
    });
    expect(row(r, `Fam @${P1S}`).compat).toMatchObject({ state: 'other-printer' });
    expect(row(r, `Fam @${P1S}`).compat?.family).toBeUndefined();
    // No copy for an added printer: still unsupported.
    expect(row(r, `Solo @${H2D}`).status).toBe('unsupported');
    expect(row(r, `Solo @${H2D}`).compat?.family).toBeUndefined();

    const f = r.findings.find((x) => x.presetName === `Fam @${H2D}`)!;
    expect(f).toMatchObject({ ruleId: R2_ID, status: 'info', severity: 'info' });
    expect(f.title).toBe("A copy for a printer you haven't added");
    expect(f.explanation).toContain('lists your custom filament presets "Fam @…" under one name');
    expect(f.explanation).toContain(`The copy "Fam @${X2D('0.4')}" is offered for the printer`);
    expect(f.explanation).toContain('only adds a greyed-out "Fam" under "Unsupported presets"');
    expect(f.explanation).toContain('Nothing to do.');
    const nozzle = r.findings.find((x) => x.presetName === `Fam @${X2D('0.8')}`)!;
    expect(nozzle).toMatchObject({ ruleId: R3_ID, status: 'info' });

    const note = r.findings.find((x) => x.ruleId === FAMILY_NOTE_ID)!;
    expect(note).toMatchObject({
      status: 'info',
      severity: 'info',
      title: 'Copies of presets you already use on your printers',
    });
    expect(note.presetType).toBeUndefined();
    expect(note.explanation).toContain('2 filament presets are copies of your custom filament');
    expect(note.explanation).toContain('another copy of it is for a printer');
    expect(note.explanation).toContain('custom filament preset "Fam", made for printers');
    expect(note.explanation).toContain('Nothing to do.');
  });

  it('names a copy for another added printer when none is for the selected one', async () => {
    const r = await scanWith([custom(`Fam @${P1S}`), custom(`Fam @${H2D}`)]);
    expect(row(r, `Fam @${H2D}`).compat?.family).toEqual({
      alias: 'Fam',
      copy: `Fam @${P1S}`,
      copyState: 'other-printer',
      copyPrinters: [P1S],
    });
    const f = r.findings.find((x) => x.presetName === `Fam @${H2D}`)!;
    expect(f.explanation).toContain(
      `is offered for ${P1S}, which you've added; when you select it, "Fam" in the list is that copy`,
    );
  });

  it('follows Studio: the part before "@", trimmed; root filaments only; never processes', async () => {
    const r = await scanWith([
      custom(`Trim@${X2D('0.4')}`),
      custom(`Trim   @${H2D}`),
      // Based on a system preset: Studio gives it no alias.
      fil(`Kid @${H2D}`, 'Generic PLA @BBL H2D'),
      custom(`Kid @${X2D('0.4')}`),
      { type: 'process', name: `Proc @${H2D}`, base: true, extra: { compatible_printers: [H2D] } },
      {
        type: 'process',
        name: `Proc @${X2D('0.4')}`,
        base: true,
        extra: { compatible_printers: [X2D('0.4')] },
      },
      custom(`@${H2D}`),
      custom(`@${X2D('0.4')}`),
    ]);
    expect(row(r, `Trim   @${H2D}`).compat?.family?.alias).toBe('Trim');
    expect(row(r, `Kid @${H2D}`).status).toBe('unsupported');
    expect(row(r, `Proc @${H2D}`).status).toBe('unsupported');
    // Nothing before "@": no alias.
    expect(row(r, `@${H2D}`).status).toBe('unsupported');
  });

  it("leaves out a copy that Studio gives no alias: one holding a printer of an earlier copy's", async () => {
    // In file name order, the H2D copy takes "Dup" for the H2D first; the X2D copy also lists
    // the H2D, so Studio keeps its full name and the H2D copy has no usable copy in its family.
    const r = await scanWith([
      custom(`Dup @${X2D('0.4')}`, { compatible_printers: [X2D('0.4'), H2D] }),
      custom(`Dup @${H2D}`),
    ]);
    expect(row(r, `Dup @${X2D('0.4')}`).compat?.state).toBe('selected');
    expect(row(r, `Dup @${H2D}`).status).toBe('unsupported');
    expect(r.findings.some((f) => f.ruleId === FAMILY_NOTE_ID)).toBe(false);
  });

  it('says where the copies are when OrcaSlicer hides the Unsupported group', async () => {
    const f = familyCopiesFinding(
      [{ name: 'Fam @X', family: { alias: 'Fam', copy: 'Fam @Y', copyState: 'selected' } }],
      { checked: true, enabled: [], userPrinters: 0, unsupportedGroup: 'hidden-by-setting' },
      ORCA,
    )!;
    expect(f.explanation).toContain('1 filament preset is a copy');
    expect(f.explanation).toContain('"Show unsupported presets" is on');
    expect(f.explanation).not.toContain('greyed out');
  });
});

describe('the conf: added and selected printers', () => {
  it('treats an empty models list as "no printers added"', async () => {
    const r = await scanWith([fil('For X2D', 'Generic PLA @BBL X2D 0.4 nozzle')], {
      models: [],
    });
    expect(r.compat).toMatchObject({ checked: true, enabled: [] });
    expect(row(r, 'For X2D').compat?.state).toBe('printer-not-added');
  });

  it('ignores a selected printer that is not loaded', async () => {
    const r = await scanWith(
      [fil('For P1S', 'Generic PLA @BBL P1S'), fil('For X2D', 'Generic PLA @BBL X2D 0.4 nozzle')],
      { models: MODELS, presets: { machine: 'Bambu Lab Nope 0.4 nozzle' } },
    );
    expect(r.compat.selectedPrinter).toBeUndefined();
    // Nothing is "selected", so both are for an added printer, and no grouped note is made.
    expect(row(r, 'For X2D').compat?.state).toBe('other-printer');
    expect(row(r, 'For P1S').compat?.state).toBe('other-printer');
    expect(r.findings.some((f) => f.ruleId === R3_NOTE_ID)).toBe(false);
  });

  it('counts the selected printer as added when the conf has no models', async () => {
    const r = await scanWith([fil('For X2D', 'Generic PLA @BBL X2D 0.4 nozzle')], {
      presets: PRESETS,
    });
    expect(r.compat).toMatchObject({ checked: true, selectedPrinter: X2D('0.4'), enabled: [] });
    expect(row(r, 'For X2D').compat?.state).toBe('selected');
  });

  it.each([
    ['no-conf', undefined],
    ['no-printers', conf({})],
    ['conf-unreadable', '{"app": {'],
  ] as const)('skips the printer checks without a warning: %s', async (why, text) => {
    const fs = fakeStudio(
      SYSTEM,
      [fil('For H2D', 'Generic PLA @BBL H2D')],
      text === undefined ? {} : { conf: text },
    );
    const r = await scan(fs);
    expect(r.compat).toMatchObject({ checked: false, why });
    expect(row(r, 'For H2D').compat).toBeUndefined();
    expect(row(r, 'For H2D').ruleIds).toEqual(['R4_MALFORMED']);
    expect(r.findings.some((f) => f.ruleId === R2_ID)).toBe(false);
    expect(r.warnings.filter((w) => /printer/i.test(w))).toEqual([]);
  });

  it('skips the printer checks when the printer index is unreadable', async () => {
    const fs = fakeStudio(SYSTEM, [fil('For H2D', 'Generic PLA @BBL H2D')], {
      conf: conf({ models: MODELS, presets: PRESETS }),
    });
    const index = JSON.parse(await fs.readText('system/BBL.json')) as Record<string, unknown>;
    index['machine_list'] = 'oops';
    await fs.writeText('system/BBL.json', JSON.stringify(index));
    const r = await scan(fs);
    expect(r.compat).toMatchObject({ checked: false, why: 'system-unreadable' });
  });
});

describe('the grouped note', () => {
  it('counts presets for another added printer and for another process', async () => {
    const r = await scanWith([
      fil('For P1S', 'Generic PLA @BBL P1S'),
      fil('For X2D 06', 'Generic PLA @BBL X2D 0.4 nozzle', { compatible_printers: [X2D('0.6')] }),
      fil('Other Proc', 'Generic PLA @BBL X2D 0.4 nozzle', {
        compatible_prints: ['0.12mm Fine @BBL X2D'],
      }),
      fil('Proc Cond', 'Generic PLA @BBL X2D 0.4 nozzle', {
        compatible_prints_condition: 'layer_height > 0.1',
      }),
    ]);
    expect(row(r, 'Other Proc').compat).toMatchObject({ state: 'selected', process: 'mismatch' });
    expect(row(r, 'Proc Cond').compat).toMatchObject({ state: 'selected', process: 'cant-tell' });
    const notes = r.findings.filter((f) => f.ruleId === R3_NOTE_ID);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      severity: 'info',
      status: 'info',
      presetPath: 'BambuStudio.conf',
      title: "Some presets are for another printer you've added",
    });
    expect(notes[0]!.presetType).toBeUndefined();
    expect(notes[0]!.explanation).toContain('2 filament presets are made for another printer');
    // X2D 0.6 is the selected model with another nozzle.
    expect(notes[0]!.explanation).toContain('more than one nozzle size in one project');
    expect(notes[0]!.explanation).toContain('1 filament preset is only for other process presets');
    for (const n of ['For P1S', 'For X2D 06', 'Other Proc']) {
      expect(row(r, n).status).toBe('info');
      expect(row(r, n).ruleIds).toEqual(['R4_MALFORMED']);
    }
  });

  it('is left out when there is nothing to count', async () => {
    const r = await scanWith([fil('For X2D', 'Generic PLA @BBL X2D 0.4 nozzle')]);
    expect(r.findings.some((f) => f.ruleId === R3_NOTE_ID)).toBe(false);
  });
});

describe('judgeCompat (pure)', () => {
  const ref = (name: string, model: string, nozzle: string, vendor: string | null): PrinterRef => ({
    name,
    model,
    nozzle,
    vendor,
    isUser: false,
  });
  const eff = (printers: string[] | null, vendor: string | null): EffectiveCompat => ({
    printers,
    printersCondition: '',
    prints: null,
    printsCondition: '',
    vendor,
    source: { kind: 'own' },
  });
  const other = ref('Other X1 0.4 nozzle', 'Other X1', '0.4', 'Other');
  const inputs = (vendorCheck: boolean): CompatInputs => ({
    enabled: [other],
    selected: other,
    knownPrinters: new Map([[other.name, other]]),
    enabledModels: [{ vendor: 'Other', model: 'Other X1', nozzles: ['0.4'] }],
    vendorCheck,
  });

  it('applies the vendor check only when the profile does (OrcaSlicer has none)', () => {
    expect(judgeCompat(eff([other.name], 'BBL'), 'filament', inputs(true)).state).toBe(
      'other-vendor',
    );
    expect(judgeCompat(eff([other.name], 'BBL'), 'filament', inputs(false)).state).toBe('selected');
  });

  it('checks the vendor before an empty list, as Studio does', () => {
    const root: PrinterRef = { name: 'My Printer', vendor: null, isUser: true };
    const bbl = ref('Bambu Lab X2D 0.4 nozzle', 'Bambu Lab X2D', '0.4', 'BBL');
    const open = eff([], 'BBL');
    const only = (selected: PrinterRef, enabled: PrinterRef[]): CompatInputs => ({
      enabled,
      selected,
      knownPrinters: new Map(),
      enabledModels: [],
      vendorCheck: true,
    });
    expect(judgeCompat(open, 'filament', only(root, [root]))).toMatchObject({
      state: 'other-vendor',
      matchedPrinters: ['My Printer'],
      vendor: 'BBL',
    });
    expect(judgeCompat(open, 'filament', only(root, [root, bbl]))).toMatchObject({
      state: 'other-printer',
      matchedPrinters: [bbl.name],
    });
    expect(judgeCompat(open, 'filament', only(bbl, [root, bbl])).state).toBe('all');
    // OrcaSlicer: no vendor check.
    expect(judgeCompat(open, 'filament', { ...only(root, [root]), vendorCheck: false }).state).toBe(
      'all',
    );
  });

  it('says it cannot tell for values it cannot read', () => {
    const d: CompatDetail = judgeCompat(
      { ...eff(null, null), opaque: true },
      'process',
      inputs(true),
    );
    expect(d).toMatchObject({ state: 'cant-tell', why: 'opaque' });
  });
});

describe('fixtures', () => {
  it.each(FIXTURE_NAMES.filter((n) => n !== 'unsupported-bambu'))(
    '%s: printer checks are skipped and nothing else changes',
    async (name) => {
      const r = await scan(nodeFs(fixtureRoot(name), { readOnly: true }));
      expect(r.compat).toEqual({
        checked: false,
        why: 'no-printers',
        enabled: [],
        userPrinters: 0,
        unsupportedGroup: 'shown',
      });
      expect(r.presets.some((p) => p.compat !== undefined || p.status === 'unsupported')).toBe(
        false,
      );
      expect(r.findings.some((f) => f.compat !== undefined)).toBe(false);
    },
  );

  it('unsupported-bambu: the expectations in the fixture README', async () => {
    const r = await scan(nodeFs(fixtureRoot('unsupported-bambu'), { readOnly: true }));
    const state = (n: string) => {
      const p = row(r, n);
      return [p.status, p.compat?.state, p.compat?.process].filter(Boolean).join(' ');
    };
    expect(r.warnings).toEqual([]);
    expect(r.compat).toEqual({
      checked: true,
      selectedPrinter: X2D('0.4'),
      selectedProcess: '0.20mm Standard @BBL X2D',
      enabled: [
        { vendor: 'BBL', model: 'Bambu Lab X2D', nozzles: ['0.4', '0.6'] },
        { vendor: 'BBL', model: 'Bambu Lab P1S', nozzles: ['0.4'] },
      ],
      userPrinters: 1,
      unsupportedGroup: 'shown',
    });
    expect({
      'On X2D': state('On X2D'),
      'On P1S': state('On P1S'),
      'On H2D': state('On H2D'),
      'On X2D 08': state('On X2D 08'),
      'For My X2D': state('For My X2D'),
      'Unknown Printer': state('Unknown Printer'),
      'Condition Only': state('Condition Only'),
      'Other Process': state('Other Process'),
      'My PLA @Bambu Lab H2D 0.4 nozzle': state('My PLA @Bambu Lab H2D 0.4 nozzle'),
      'My PETG @Bambu Lab X2D 0.4 nozzle': state('My PETG @Bambu Lab X2D 0.4 nozzle'),
      'My PETG @Bambu Lab H2D 0.4 nozzle': state('My PETG @Bambu Lab H2D 0.4 nozzle'),
      'My X2D': state('My X2D'),
    }).toEqual({
      'On X2D': 'ok selected',
      'On P1S': 'ok other-printer',
      'On H2D': 'unsupported printer-not-added',
      'On X2D 08': 'unsupported nozzle-not-added',
      'For My X2D': 'ok other-printer',
      'Unknown Printer': 'unsupported unknown-printers',
      'Condition Only': 'ok cant-tell',
      'Other Process': 'ok selected mismatch',
      'My PLA @Bambu Lab H2D 0.4 nozzle': 'unsupported printer-not-added',
      'My PETG @Bambu Lab X2D 0.4 nozzle': 'ok selected',
      'My PETG @Bambu Lab H2D 0.4 nozzle': 'info printer-not-added',
      'My X2D': 'ok',
    });
    expect(row(r, 'On P1S').compat?.matchedPrinters).toEqual([P1S]);
    expect(row(r, 'For My X2D').compat?.matchedPrinters).toEqual(['My X2D']);
    expect(row(r, 'Unknown Printer').compat?.guessed).toBe(true);
    expect(row(r, 'My PLA @Bambu Lab H2D 0.4 nozzle').compat?.source).toEqual({ kind: 'name' });

    const byRule = (id: string) =>
      r.findings.filter((f) => f.ruleId === id).map((f) => f.presetName);
    expect(byRule(R2_ID).sort()).toEqual(
      [
        'My PETG @Bambu Lab H2D 0.4 nozzle',
        'My PLA @Bambu Lab H2D 0.4 nozzle',
        'On H2D',
        'Unknown Printer',
      ].sort(),
    );
    // "My PETG" has a copy for the selected printer: one name in Studio, so only a note.
    expect(row(r, 'My PETG @Bambu Lab H2D 0.4 nozzle').compat?.family).toEqual({
      alias: 'My PETG',
      copy: 'My PETG @Bambu Lab X2D 0.4 nozzle',
      copyState: 'selected',
    });
    const copies = r.findings.find((f) => f.ruleId === FAMILY_NOTE_ID)!;
    expect(copies.explanation).toContain('1 filament preset is a copy of your custom filament');
    expect(copies.explanation).toContain('custom filament preset "My PETG", made for a printer');
    expect(byRule(R3_ID)).toEqual(['On X2D 08']);
    const note = r.findings.find((f) => f.ruleId === R3_NOTE_ID)!;
    expect(note.explanation).toContain('2 process presets are made for another printer');
    expect(note.explanation).toContain('1 filament preset is only for other process presets');
    // "My X2D" is the same model and nozzle as the selected printer: no multi-nozzle hint.
    expect(note.explanation).not.toContain('more than one nozzle size');
    // Report-only: nothing to repair.
    expect(r.findings.some((f) => f.proposedFix !== undefined)).toBe(false);
  });
});

// Read-only check against the real install: npm run test:live -- compat
describe.runIf(process.env['PRESET_DOCTOR_LIVE'] === '1')('live printer checks (read-only)', () => {
  it('reads the added printers and judges every loaded filament and process preset', async () => {
    const fs = nodeFs(defaultPaths().studioRoot, { readOnly: true });
    const r = await scan(fs);
    expect(r.compat.checked).toBe(true);
    expect(r.compat.enabled.length).toBeGreaterThan(0);
    for (const p of r.presets) {
      const loaded = p.status !== 'hidden' && p.status !== 'broken';
      if (p.type === 'machine' || !loaded) expect(p.compat).toBeUndefined();
      // R2/R3 make a row 'unsupported', unless it is a copy of a custom filament in use.
      expect(p.status === 'unsupported').toBe(
        (p.ruleIds.includes(R2_ID) || p.ruleIds.includes(R3_ID)) && p.compat?.family === undefined,
      );
    }
    const compatFindings = r.findings.filter((f) => f.compat !== undefined);
    expect(compatFindings.every((f) => f.proposedFix === undefined)).toBe(true);
  });
});
