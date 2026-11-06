// Test-only (excluded from the build). Node-only. Shared by scripts/r1-simulate.ts and the
// guarded live test in rules/r1.test.ts: measures R1 candidate ranking against a real profile.
//
// The Studio folder is only read: its system presets are copied into memory once and every
// scenario runs on that copy.
//
// For every instantiable system preset P with a printer code (e.g. "Generic PETG @BBL X2D"):
//
//   hidden   P disappears from the index and a user preset inherits P's name. The right fix is
//            any remaining preset whose compatible_printers covers P's nozzles for P's printer.
//            The mode is "suffixed" when P's name has a nozzle size, "unsuffixed" otherwise.
//   renamed  P stays, but the user preset inherits another spelling of it, as when Bambu
//            renamed "... X2D 0.6 nozzle" to "... X2D" in 02.08.00.06: P's name plus each of its
//            sizes (suffixed mode; the right fix covers that size), or P's name without its size
//            (unsuffixed mode; the right fix covers P's sizes). Spellings that exist are skipped.
//
// Each scenario runs four times: with or without the orphan's own compatible_printers (the
// "<model> <size> nozzle" entries the right fix must cover), and with or without a .info sidecar
// whose base_id is P's setting_id (in hidden mode nothing has that id any more).
//
// "Correct" = the pre-selected candidate's effective compatible_printers lists every required
// size for P's printer model.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseInfoFile } from '../infoFile.js';
import { memFs } from '../memFs.js';
import { parseCompatiblePrinter, parsePresetName, sameNozzle } from '../names.js';
import { buildUserIndex } from '../resolve.js';
import { checkR1 } from '../rules/r1.js';
import { loadSystemIndexes, studioNameLookup, type SystemIndex } from '../systemIndex.js';
import type { Finding, UserPreset } from '../types.js';

export type Outcome = 'correct' | 'wrong' | 'unselected' | 'medium' | 'none';
export const OUTCOMES: readonly Outcome[] = ['correct', 'wrong', 'unselected', 'medium', 'none'];

export interface SimulationRow {
  kind: 'hidden' | 'renamed';
  mode: 'unsuffixed' | 'suffixed';
  compat: boolean;
  baseId: boolean;
  counts: Record<Outcome, number>;
  /** Of the medium-only runs, how many list a right fix first. */
  mediumTopRight: number;
}

export interface SimulationResult {
  version: string | null;
  scenarios: number;
  rows: SimulationRow[];
  /** One line per wrong pre-selection. */
  wrong: string[];
}

/** system/<Vendor>.json plus every file under system/<Vendor>/filament/, read into memory. */
export function readSystemCopy(studioRoot: string): Record<string, string> {
  const files: Record<string, string> = {};
  const sys = join(studioRoot, 'system');
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(abs, e.name), `${rel}/${e.name}`);
      else if (e.isFile()) files[`${rel}/${e.name}`] = readFileSync(join(abs, e.name), 'utf8');
    }
  };
  for (const e of readdirSync(sys, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.json')) continue;
    files[`system/${e.name}`] = readFileSync(join(sys, e.name), 'utf8');
    const filament = join(sys, e.name.slice(0, -'.json'.length), 'filament');
    if (existsSync(filament)) walk(filament, `system/${e.name.slice(0, -'.json'.length)}/filament`);
  }
  return files;
}

export async function loadSystemCopy(studioRoot: string): Promise<SystemIndex> {
  return loadSystemIndexes(memFs(readSystemCopy(studioRoot)));
}

function nozzlesFor(compat: readonly string[] | null, model: string): string[] {
  const out: string[] = [];
  for (const entry of compat ?? []) {
    const cp = parseCompatiblePrinter(entry);
    if (cp && cp.model === model && !out.some((n) => sameNozzle(n, cp.nozzle))) out.push(cp.nozzle);
  }
  return out;
}

/** The index without one name, as if Bambu had dropped that preset. */
function without(sys: SystemIndex, hidden: string): SystemIndex {
  const entries = new Map(sys.entries);
  entries.delete(hidden);
  return {
    ...sys,
    warnings: [],
    entries,
    has: (n) => n !== hidden && sys.has(n),
    get: (n) => (n === hidden ? undefined : sys.get(n)),
    names: () => sys.names().filter((n) => n !== hidden),
    namesWithStem: (s) => sys.namesWithStem(s).filter((n) => n !== hidden),
    load: (n) => (n === hidden ? Promise.resolve(null) : sys.load(n)),
    loadAll: async () => (await sys.loadAll()).filter((p) => p.name !== hidden),
    findByStudioName: async (n) => {
      const hit = await sys.findByStudioName(n);
      return hit && hit.name !== hidden ? hit : null;
    },
  };
}

function orphan(inherits: string, compat: string[] | null, baseId: string | null): UserPreset {
  const json: Record<string, unknown> = { from: 'User', inherits, name: 'Simulated orphan' };
  if (compat) json['compatible_printers'] = compat;
  const preset: UserPreset = {
    accountId: '1000000001',
    path: 'user/1000000001/filament/Simulated orphan.json',
    fileStem: 'Simulated orphan',
    isBase: false,
    raw: JSON.stringify(json, null, 4),
    json,
    infoPath: 'user/1000000001/filament/Simulated orphan.info',
  };
  if (baseId !== null) {
    preset.infoRaw =
      'sync_info = \r\nuser_id = 1000000001\r\nsetting_id = PFUS0000000000000a\r\n' +
      `base_id = ${baseId}\r\nupdated_time = 1782278409\r\n`;
    preset.info = parseInfoFile(preset.infoRaw);
  }
  return preset;
}

interface Scenario {
  kind: SimulationRow['kind'];
  mode: SimulationRow['mode'];
  source: string;
  missing: string;
  model: string;
  required: string[];
  settingId: string | undefined;
}

async function buildScenarios(system: SystemIndex): Promise<Scenario[]> {
  const out: Scenario[] = [];
  for (const p of await system.loadAll()) {
    if (!p.instantiation) continue;
    const parsed = system.parsed(p.name);
    if (!parsed?.printerCode || parsed.model !== undefined) continue;
    const model = await system.modelOf(parsed);
    if (model === null) continue;
    const nozzles = nozzlesFor(await system.effectiveCompatiblePrinters(p.name), model);
    if (nozzles.length === 0) continue;
    const base = { source: p.name, model, settingId: p.settingId };

    out.push({
      ...base,
      kind: 'hidden',
      mode: parsed.nozzle === undefined ? 'unsuffixed' : 'suffixed',
      missing: p.name,
      required: nozzles,
    });
    if (parsed.nozzle === undefined) {
      for (const n of nozzles) {
        const missing = `${p.name} ${n} nozzle`;
        if (!system.has(missing)) {
          out.push({ ...base, kind: 'renamed', mode: 'suffixed', missing, required: [n] });
        }
      }
    } else {
      const missing = p.name.slice(0, -` ${parsed.nozzle} nozzle`.length);
      if (!system.has(missing)) {
        out.push({ ...base, kind: 'renamed', mode: 'unsuffixed', missing, required: nozzles });
      }
    }
  }
  return out;
}

function candidatesOf(f: Finding | null) {
  return f?.proposedFix?.kind === 'setInherits' ? f.proposedFix.candidates : [];
}

export async function simulateR1(system: SystemIndex): Promise<SimulationResult> {
  const scenarios = await buildScenarios(system);
  const rows = new Map<string, SimulationRow>();
  const wrong: string[] = [];

  for (const s of scenarios) {
    const sys = s.kind === 'hidden' ? without(system, s.source) : system;
    const covers = async (name: string): Promise<boolean> => {
      const have = nozzlesFor(await sys.effectiveCompatiblePrinters(name), s.model);
      return s.required.every((r) => have.some((n) => sameNozzle(n, r)));
    };
    for (const compat of [false, true]) {
      for (const baseId of [false, true]) {
        if (baseId && s.settingId === undefined) continue;
        const preset = orphan(
          s.missing,
          compat ? s.required.map((n) => `${s.model} ${n} nozzle`) : null,
          baseId ? (s.settingId ?? null) : null,
        );
        // Parents resolve by Studio's names, exactly as scan() does.
        const ctx = {
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
        let topRight = false;
        if (pick) {
          outcome = (await covers(pick.name)) ? 'correct' : 'wrong';
          if (outcome === 'wrong') {
            wrong.push(
              `${s.kind}/${s.mode}${compat ? '+compat' : ''}${baseId ? '+base_id' : ''}: ` +
                `"${s.missing}" (needs ${s.required.join('/')}) -> "${pick.name}"`,
            );
          }
        } else if (cs.some((c) => c.confidence === 'high')) {
          outcome = 'unselected';
        } else if (cs.some((c) => c.confidence === 'medium')) {
          outcome = 'medium';
          topRight = await covers(cs[0]!.name);
        } else {
          outcome = 'none';
        }
        const key = `${s.kind} ${s.mode} ${compat} ${baseId}`;
        let row = rows.get(key);
        if (!row) {
          row = {
            kind: s.kind,
            mode: s.mode,
            compat,
            baseId,
            counts: { correct: 0, wrong: 0, unselected: 0, medium: 0, none: 0 },
            mediumTopRight: 0,
          };
          rows.set(key, row);
        }
        row.counts[outcome]++;
        if (topRight) row.mediumTopRight++;
      }
    }
  }
  const order = (r: SimulationRow): string =>
    `${r.kind} ${r.mode} ${Number(r.compat)} ${Number(r.baseId)}`;
  return {
    version: system.version,
    scenarios: scenarios.length,
    rows: [...rows.values()].sort((a, b) => (order(a) < order(b) ? -1 : 1)),
    wrong,
  };
}

/** How a sidecar's base_id relates to the preset's own (existing) system parent. */
export interface SidecarAgreement {
  /** Sidecars with a base_id whose preset's parent is a system preset. */
  checked: number;
  sameParent: number;
  sameStemAndPrinterOtherNozzle: number;
  otherPrinter: number;
  otherStem: number;
  /** base_id is no system preset's setting_id (e.g. a user preset's). */
  notSystem: number;
}

/**
 * Reads every account's filament sidecars (read-only) and compares base_id with the setting_id
 * of the preset's parent. Counts only; no names or ids leave this function.
 */
export async function measureSidecars(
  studioRoot: string,
  system: SystemIndex,
): Promise<SidecarAgreement> {
  const bySetting = new Map<string, string>();
  for (const p of await system.loadAll()) if (p.settingId) bySetting.set(p.settingId, p.name);
  const out: SidecarAgreement = {
    checked: 0,
    sameParent: 0,
    sameStemAndPrinterOtherNozzle: 0,
    otherPrinter: 0,
    otherStem: 0,
    notSystem: 0,
  };
  const userDir = join(studioRoot, 'user');
  if (!existsSync(userDir)) return out;
  for (const account of readdirSync(userDir, { withFileTypes: true })) {
    if (!account.isDirectory()) continue;
    const dir = join(userDir, account.name, 'filament');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.info') || !existsSync(join(dir, f.slice(0, -5) + '.json'))) continue;
      const baseId = /^base_id = (\S+)/m.exec(readFileSync(join(dir, f), 'utf8'))?.[1];
      if (!baseId) continue;
      let json: unknown;
      try {
        json = JSON.parse(readFileSync(join(dir, f.slice(0, -5) + '.json'), 'utf8'));
      } catch {
        continue;
      }
      const parent =
        typeof json === 'object' && json !== null && 'inherits' in json ? json.inherits : '';
      if (typeof parent !== 'string' || !system.has(parent)) continue;
      out.checked++;
      const named = bySetting.get(baseId);
      if (named === undefined) {
        out.notSystem++;
        continue;
      }
      if (named === parent) {
        out.sameParent++;
        continue;
      }
      const a = parsePresetName(parent);
      const b = parsePresetName(named);
      if (a?.stem.toLowerCase() !== b?.stem.toLowerCase()) out.otherStem++;
      else if (a?.printerCode !== b?.printerCode) out.otherPrinter++;
      else out.sameStemAndPrinterOtherNozzle++;
    }
  }
  return out;
}
