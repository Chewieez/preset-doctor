// Test-only (excluded from the build). Node-only. The process and printer counterpart of
// r1Simulation.ts, shared by scripts/r1-simulate.ts and the guarded live test in
// rules/r1Process.test.ts: measures R1 for process and machine presets against a real profile.
//
// The Studio folder is only read: its process and machine system presets are copied into memory
// once and every scenario runs on that copy.
//
// Process presets, for every instantiable system process P whose name parses and whose effective
// compatible_printers is not empty:
//   hidden   P disappears from the index and a user process inherits P's name.
//   renamed  P stays, but the user process inherits another spelling of it: P's name in lower
//            case, and (for a name without a size) P's name plus " 0.4 nozzle" when P is for the
//            0.4 nozzle. Spellings that exist are skipped.
// "Correct" = the pre-selected candidate has P's layer height and its effective
// compatible_printers lists every printer P lists, so the user process keeps its printers.
//
// Printer presets, for every instantiable system printer M (file type "machine"): M disappears
// and a user printer inherits M's name. Printer candidates must never be pre-selected, so any
// pre-selection counts as wrong.
//
// Each scenario runs with and without a .info sidecar whose base_id is the setting_id of P or M.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseInfoFile } from '../infoFile.js';
import { memFs } from '../memFs.js';
import { parseCompatiblePrinter, parseProcessName, sameNozzle } from '../names.js';
import { buildUserIndex } from '../resolve.js';
import { checkR1 } from '../rules/r1.js';
import { LIST_KEY, loadSystemIndexes, studioNameLookup, type SystemIndex } from '../systemIndex.js';
import { TERMS } from '../terms.js';
import type { PresetType, UserPreset } from '../types.js';
import { candidatesOf, OUTCOMES, without, type Outcome } from './r1Simulation.js';

export interface TypeSimulationRow {
  type: 'process' | 'machine';
  kind: 'hidden' | 'renamed';
  baseId: boolean;
  counts: Record<Outcome, number>;
}

export interface TypeSimulationResult {
  version: string | null;
  scenarios: number;
  rows: TypeSimulationRow[];
  /** One line per wrong pre-selection. */
  wrong: string[];
}

/** system/<Vendor>.json plus every file under system/<Vendor>/<type>/, read into memory. */
export function readTypeCopy(
  studioRoot: string,
  type: 'process' | 'machine',
): Record<string, string> {
  const files: Record<string, string> = {};
  const sys = join(studioRoot, 'system');
  for (const e of readdirSync(sys, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.json')) continue;
    files[`system/${e.name}`] = readFileSync(join(sys, e.name), 'utf8');
    const vendor = e.name.slice(0, -'.json'.length);
    const dir = join(sys, vendor, type);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isFile())
        files[`system/${vendor}/${type}/${f.name}`] = readFileSync(join(dir, f.name), 'utf8');
    }
  }
  return files;
}

export async function loadTypeCopy(
  studioRoot: string,
  type: 'process' | 'machine',
): Promise<SystemIndex> {
  return loadSystemIndexes(memFs(readTypeCopy(studioRoot, type)), {
    listKey: LIST_KEY[type],
    optionalList: true,
  });
}

function orphan(type: PresetType, inherits: string, baseId: string | null): UserPreset {
  const ids = TERMS[type].settingsIdKey;
  const json: Record<string, unknown> = {
    from: 'User',
    inherits,
    name: 'Simulated orphan',
    [ids.key]: 'Simulated orphan',
  };
  const path = `user/1000000001/${type}/Simulated orphan.json`;
  const preset: UserPreset = {
    type,
    accountId: '1000000001',
    path,
    fileStem: 'Simulated orphan',
    isBase: false,
    raw: JSON.stringify(json, null, 4),
    json,
    infoPath: path.replace(/\.json$/, '.info'),
  };
  if (baseId !== null) {
    preset.infoRaw =
      'sync_info = \r\nuser_id = 1000000001\r\nsetting_id = PPUS0000000000000a\r\n' +
      `base_id = ${baseId}\r\nupdated_time = 1782278409\r\n`;
    preset.info = parseInfoFile(preset.infoRaw);
  }
  return preset;
}

function samePrinter(a: string, b: string): boolean {
  const pa = parseCompatiblePrinter(a);
  const pb = parseCompatiblePrinter(b);
  if (!pa || !pb) return a === b;
  return pa.model === pb.model && sameNozzle(pa.nozzle, pb.nozzle);
}

interface Scenario {
  kind: TypeSimulationRow['kind'];
  source: string;
  missing: string;
  settingId: string | undefined;
  /** Process: the printers the right fix must list. */
  printers: string[];
  layer: string;
}

async function run(
  type: 'process' | 'machine',
  system: SystemIndex,
  scenarios: Scenario[],
  isCorrect: (s: Scenario, sys: SystemIndex, pick: string) => Promise<boolean>,
): Promise<{ rows: TypeSimulationRow[]; wrong: string[] }> {
  const rows = new Map<string, TypeSimulationRow>();
  const wrong: string[] = [];
  for (const s of scenarios) {
    const sys = s.kind === 'hidden' ? without(system, s.source) : system;
    for (const baseId of [false, true]) {
      if (baseId && s.settingId === undefined) continue;
      const preset = orphan(type, s.missing, baseId ? (s.settingId ?? null) : null);
      const ctx = {
        type,
        system: sys,
        presets: [preset],
        resolve: {
          system: await studioNameLookup(sys, [preset]),
          userByName: buildUserIndex([preset]),
        },
      };
      const cs = candidatesOf(await checkR1(preset, ctx));
      const pick = cs.find((c) => c.preselected);
      let outcome: Outcome;
      if (pick) {
        outcome = (await isCorrect(s, sys, pick.name)) ? 'correct' : 'wrong';
        if (outcome === 'wrong') {
          wrong.push(
            `${type} ${s.kind}${baseId ? '+base_id' : ''}: "${s.missing}" -> "${pick.name}"`,
          );
        }
      } else if (cs.some((c) => c.confidence === 'high')) {
        outcome = 'unselected';
      } else if (cs.some((c) => c.confidence === 'medium')) {
        outcome = 'medium';
      } else {
        outcome = 'none';
      }
      const key = `${s.kind} ${baseId}`;
      let row = rows.get(key);
      if (!row) {
        const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
        row = { type, kind: s.kind, baseId, counts };
        rows.set(key, row);
      }
      row.counts[outcome]++;
    }
  }
  const order = (r: TypeSimulationRow): string => `${r.kind} ${Number(r.baseId)}`;
  return { rows: [...rows.values()].sort((a, b) => (order(a) < order(b) ? -1 : 1)), wrong };
}

export async function simulateR1Process(system: SystemIndex): Promise<TypeSimulationResult> {
  const scenarios: Scenario[] = [];
  for (const p of await system.loadAll()) {
    if (!p.instantiation) continue;
    const parsed = parseProcessName(p.studioName);
    const printers = await system.effectiveCompatiblePrinters(p.name);
    if (!parsed || !printers || printers.length === 0) continue;
    const base = { source: p.name, settingId: p.settingId, printers, layer: parsed.layer };
    scenarios.push({ ...base, kind: 'hidden', missing: p.studioName });
    const lower = p.studioName.toLowerCase();
    if (lower !== p.studioName && !system.has(lower)) {
      scenarios.push({ ...base, kind: 'renamed', missing: lower });
    }
    const all04 = printers.every((e) => {
      const cp = parseCompatiblePrinter(e);
      return cp !== null && sameNozzle(cp.nozzle, '0.4');
    });
    const suffixed = `${p.studioName} 0.4 nozzle`;
    if (parsed.nozzle === undefined && all04 && !system.has(suffixed)) {
      scenarios.push({ ...base, kind: 'renamed', missing: suffixed });
    }
  }
  const { rows, wrong } = await run('process', system, scenarios, async (s, sys, pick) => {
    const entry = await sys.findByStudioName(pick);
    const have = entry ? ((await sys.effectiveCompatiblePrinters(entry.name)) ?? []) : [];
    const layer = parseProcessName(pick)?.layer;
    return (
      layer !== undefined &&
      Number(layer) === Number(s.layer) &&
      s.printers.every((need) => have.some((h) => samePrinter(h, need)))
    );
  });
  return { version: system.version, scenarios: scenarios.length, rows, wrong };
}

export async function simulateR1Machine(system: SystemIndex): Promise<TypeSimulationResult> {
  const scenarios: Scenario[] = [];
  for (const m of await system.loadAll()) {
    if (!m.instantiation || m.fileType !== 'machine') continue;
    scenarios.push({
      kind: 'hidden',
      source: m.name,
      missing: m.studioName,
      settingId: m.settingId,
      printers: [],
      layer: '',
    });
  }
  // Any pre-selected printer is wrong: the user always picks the printer they have.
  const { rows, wrong } = await run('machine', system, scenarios, async () => false);
  return { version: system.version, scenarios: scenarios.length, rows, wrong };
}
