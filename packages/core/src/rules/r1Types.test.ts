import { describe, expect, it } from 'vitest';
import type { PresetFs } from '../fs.js';
import { defaultPaths } from '../node/studioProcess.js';
import { scan } from '../scan.js';
import { loadTypeCopy, simulateR1Machine, simulateR1Process } from '../testing/r1TypeSimulation.js';
import {
  fakeStudio,
  sidecar,
  type FakeSystemPreset,
  type FakeUserPreset,
} from '../testing/studio.js';
import type { Candidate, Finding } from '../types.js';
import { R1_ID } from './r1.js';

const X1C = 'Bambu Lab X1 Carbon 0.4 nozzle';
const P1S = 'Bambu Lab P1S 0.4 nozzle';
const X2D = (n: string) => `Bambu Lab X2D ${n} nozzle`;

const proc = (
  name: string,
  compatible_printers: string[],
  setting_id: string,
  extra: Partial<FakeSystemPreset> = {},
): FakeSystemPreset => ({
  type: 'process',
  name,
  inherits: 'fdm_process_common',
  compatible_printers,
  setting_id,
  ...extra,
});

const PROCESSES: FakeSystemPreset[] = [
  { type: 'process', name: 'fdm_process_common', instantiation: 'false' },
  proc('0.20mm Standard @BBL X1C', [X1C, P1S], 'GP004'),
  proc('0.16mm Standard @BBL X1C', [X1C, P1S], 'GP005'),
  proc('0.20mm Standard @BBL X2D', [X2D('0.4')], 'GP100'),
  proc('0.20mm High Quality @BBL X2D', [X2D('0.4')], 'GP101'),
  proc('0.30mm Standard @BBL X2D 0.6 nozzle', [X2D('0.6')], 'GP102'),
];

const userProc = (inherits: string, more: Partial<FakeUserPreset> = {}): FakeUserPreset => ({
  type: 'process',
  name: 'My process',
  inherits,
  ...more,
});

async function r1(fs: PresetFs): Promise<Finding[]> {
  return (await scan(fs)).findings.filter((f) => f.ruleId === R1_ID);
}

function candidates(f: Finding | undefined): Candidate[] {
  return f?.proposedFix?.kind === 'setInherits' ? f.proposedFix.candidates : [];
}

const summary = (cs: Candidate[]) =>
  cs.map((c) => `${c.confidence}${c.preselected ? '*' : ''} ${c.name}`);

describe('R1 for process presets', () => {
  it('pre-selects the same process when only capitalization differs', async () => {
    const [f] = await r1(fakeStudio(PROCESSES, [userProc('0.20mm standard @BBL X1C')]));
    expect(f).toMatchObject({ status: 'hidden', presetType: 'process', presetName: 'My process' });
    expect(summary(candidates(f))[0]).toBe('high* 0.20mm Standard @BBL X1C');
    expect(candidates(f)[0]?.printers).toEqual([X1C, P1S]);
    expect(f?.explanation).toContain(
      'The new parent decides which printers Studio offers this process for',
    );
  });

  it('pre-selects the same name with the 0.4 nozzle written out or left out', async () => {
    const [f] = await r1(fakeStudio(PROCESSES, [userProc('0.20mm Standard @BBL X2D 0.4 nozzle')]));
    const cs = candidates(f);
    expect(summary(cs)[0]).toBe('high* 0.20mm Standard @BBL X2D');
    expect(cs[0]?.reason).toBe('Same name, with the nozzle size written out or left out.');
    expect(cs.filter((c) => c.confidence === 'high')).toHaveLength(1);
  });

  it('offers other profiles for the same printers as medium, never pre-selected', async () => {
    const [f] = await r1(fakeStudio(PROCESSES, [userProc('0.20mm Optimal @BBL X2D')]));
    const cs = candidates(f);
    expect(summary(cs).slice(0, 2)).toEqual([
      'medium 0.20mm High Quality @BBL X2D',
      'medium 0.20mm Standard @BBL X2D',
    ]);
    expect(cs.some((c) => c.preselected)).toBe(false);
    expect(cs[1]?.reason).toBe(
      'Same layer height and printer, but the Standard profile, not Optimal.',
    );
  });

  it("ranks a process whose printers cover the orphan's own list high", async () => {
    const [f] = await r1(
      fakeStudio(PROCESSES, [
        userProc('0.20mm Standard @BBL N1', { extra: { compatible_printers: [P1S] } }),
      ]),
    );
    const cs = candidates(f);
    expect(summary(cs)[0]).toBe('high* 0.20mm Standard @BBL X1C');
    expect(cs[0]?.reason).toContain('Its name is for BBL X1C, but it lists your printers.');
  });

  it('lists other layer heights for the same printer as low, closest first', async () => {
    const [f] = await r1(fakeStudio(PROCESSES, [userProc('0.18mm Fine @BBL X1C')]));
    expect(summary(candidates(f))).toEqual([
      'low 0.16mm Standard @BBL X1C',
      'low 0.20mm Standard @BBL X1C',
    ]);
  });

  it('raises the process the .info base_id names, without pre-selecting it', async () => {
    const [f] = await r1(
      fakeStudio(PROCESSES, [userProc('0.20mm Standard @BBL N1', { info: sidecar('GP004') })]),
    );
    const cs = candidates(f);
    expect(cs[0]).toMatchObject({
      name: '0.20mm Standard @BBL X1C',
      confidence: 'medium',
      preselected: false,
    });
    expect(cs[0]?.reason).toBe(
      "Your preset's sync file (.info) says it was made from this preset.",
    );
  });

  it('reports a template parent as a template, with no template as a candidate', async () => {
    const [f] = await r1(fakeStudio(PROCESSES, [userProc('fdm_process_common')]));
    expect(f?.explanation).toContain('internal template');
    expect(candidates(f).some((c) => c.name.startsWith('fdm_'))).toBe(false);
  });

  it('never matches a process to a filament of the same name', async () => {
    const fs = fakeStudio(
      [...PROCESSES, { name: '0.20mm Standard @BBL X9' }],
      [userProc('0.20mm Standard @BBL X9')],
    );
    const [f] = await r1(fs);
    expect(f).toMatchObject({ presetType: 'process', status: 'hidden' });
  });

  it('leaves a process whose parent exists alone', async () => {
    expect(await r1(fakeStudio(PROCESSES, [userProc('0.20mm Standard @BBL X1C')]))).toEqual([]);
  });
});

const machine = (
  name: string,
  model: string,
  variant: string,
  setting_id: string,
): FakeSystemPreset => ({
  type: 'machine',
  name,
  inherits: 'fdm_machine_common',
  setting_id,
  extra: { printer_model: model, printer_variant: variant },
});

const MACHINES: FakeSystemPreset[] = [
  { type: 'machine', name: 'fdm_machine_common', instantiation: 'false' },
  machine('Bambu Lab X1 Carbon 0.4 nozzle', 'Bambu Lab X1 Carbon', '0.4', 'GM001'),
  machine('Bambu Lab X1 Carbon 0.6 nozzle', 'Bambu Lab X1 Carbon', '0.6', 'GM002'),
  machine('Bambu Lab A1 mini 0.4 nozzle', 'Bambu Lab A1 mini', '0.4', 'GM020'),
  // A g-code template in machine_list: no "type", never a candidate.
  {
    type: 'machine',
    name: 'Bambu Lab X1 Carbon 0.4 nozzle template',
    extra: { type: null },
  },
];

const userMachine = (inherits: string, more: Partial<FakeUserPreset> = {}): FakeUserPreset => ({
  type: 'machine',
  name: 'My printer',
  inherits,
  ...more,
});

describe('R1 for printer presets', () => {
  it('ranks the same printer high but never pre-selects it', async () => {
    const [f] = await r1(fakeStudio(MACHINES, [userMachine('Bambu lab X1 carbon 0.4 nozzle')]));
    const cs = candidates(f);
    expect(f).toMatchObject({ presetType: 'machine', status: 'hidden' });
    expect(summary(cs)[0]).toBe('high Bambu Lab X1 Carbon 0.4 nozzle');
    expect(cs.every((c) => !c.preselected)).toBe(true);
    expect(f?.explanation).toContain('Preset Doctor never picks a printer for you');
    expect(cs.some((c) => c.name.endsWith('template'))).toBe(false);
  });

  it('offers other nozzles of the same model as medium', async () => {
    const [f] = await r1(fakeStudio(MACHINES, [userMachine('Bambu Lab X1 Carbon 0.2 nozzle')]));
    expect(summary(candidates(f))).toContain('medium Bambu Lab X1 Carbon 0.4 nozzle');
    expect(candidates(f).every((c) => !c.preselected)).toBe(true);
  });

  it('raises the printer the .info base_id names, still without pre-selecting', async () => {
    const [f] = await r1(
      fakeStudio(MACHINES, [userMachine('Bambu Lab A1M 0.4 nozzle', { info: sidecar('GM020') })]),
    );
    const cs = candidates(f);
    expect(cs[0]).toMatchObject({ name: 'Bambu Lab A1 mini 0.4 nozzle', confidence: 'medium' });
    expect(cs.every((c) => !c.preselected)).toBe(true);
  });
});

// Read-only, on an in-memory copy of the real system presets:
// npm run test:live -- r1Types (same numbers as `node scripts/r1-simulate.ts`).
describe.runIf(process.env['PRESET_DOCTOR_LIVE'] === '1')(
  'live R1 process and printer simulation (read-only)',
  () => {
    const root = defaultPaths().studioRoot;
    it('never pre-selects a process that drops a printer or changes the layer height', async () => {
      const result = await simulateR1Process(await loadTypeCopy(root, 'process'));
      expect(result.scenarios).toBeGreaterThan(0);
      expect(result.wrong).toEqual([]);
      // A spelling change of a process that still exists is always repaired.
      for (const row of result.rows.filter((r) => r.kind === 'renamed')) {
        const total = Object.values(row.counts).reduce((a, b) => a + b, 0);
        expect(row.counts.correct).toBe(total);
      }
    }, 300_000);

    it('never pre-selects a printer', async () => {
      const result = await simulateR1Machine(await loadTypeCopy(root, 'machine'));
      expect(result.scenarios).toBeGreaterThan(0);
      expect(result.wrong).toEqual([]);
    }, 300_000);
  },
);
