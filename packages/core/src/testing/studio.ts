// Test-only helpers (excluded from the build): tiny Bambu Studio folders in memory, and temp
// copies of fixtures for tests that write.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memFs, type MemFs } from '../memFs.js';
import { LIST_KEY } from '../systemIndex.js';
import { TERMS } from '../terms.js';
import { PRESET_TYPES, type PresetType } from '../types.js';
import { fixtureRoot, type FixtureName, type OrcaFixtureName } from './fixtures.js';

export interface FakeSystemPreset {
  name: string;
  /** Which index list and folder it goes in. Default 'filament'. */
  type?: PresetType;
  inherits?: string;
  compatible_printers?: string[];
  setting_id?: string;
  instantiation?: 'true' | 'false';
  /** More keys for the file, e.g. printer_model. A `type` key of null leaves "type" out. */
  extra?: Record<string, unknown>;
}

export interface FakeUserPreset {
  /** Which folder it goes in. Default 'filament'. */
  type?: PresetType;
  /** File name without .json; defaults to the name. */
  file?: string;
  /** Omit to leave the key out. */
  name?: string;
  inherits?: string;
  base?: boolean;
  /** Sidecar text; omit for none. */
  info?: string;
  extra?: Record<string, unknown>;
}

/**
 * A Studio folder in memory: system/BBL.json + preset files, and user/<account>/<type>. With
 * filament presets only, BBL.json has just a filament_list, as it always did here.
 */
export function fakeStudio(
  system: FakeSystemPreset[],
  user: FakeUserPreset[],
  options: { account?: string; version?: string; conf?: string } = {},
): MemFs {
  const account = options.account ?? '1000000001';
  const index: Record<string, unknown> = {
    name: 'Bambulab',
    version: options.version ?? '02.08.00.06',
  };
  for (const type of PRESET_TYPES) {
    const list = system.filter((p) => (p.type ?? 'filament') === type);
    if (type !== 'filament' && list.length === 0) continue;
    index[LIST_KEY[type]] = list.map((p) => ({ name: p.name, sub_path: `${type}/${p.name}.json` }));
  }
  const files: Record<string, string> = { 'system/BBL.json': JSON.stringify(index) };
  for (const { type = 'filament', extra, ...p } of system) {
    const body: Record<string, unknown> = {
      type,
      from: 'system',
      instantiation: 'true',
      inherits: '',
      ...p,
      ...extra,
    };
    if (body['type'] === null) delete body['type'];
    files[`system/BBL/${type}/${p.name}.json`] = JSON.stringify(body, null, 4);
  }
  for (const u of user) {
    const type = u.type ?? 'filament';
    const file = u.file ?? u.name ?? 'Unnamed';
    const dir = `user/${account}/${type}${u.base ? '/base' : ''}`;
    const json: Record<string, unknown> = { from: 'User', ...u.extra };
    const ids = TERMS[type].settingsIdKey;
    if (u.name !== undefined) json[ids.key] = ids.shape === 'array0' ? [u.name] : u.name;
    if (u.inherits !== undefined) json['inherits'] = u.inherits;
    if (u.name !== undefined) json['name'] = u.name;
    json['version'] = '2.8.0.6';
    files[`${dir}/${file}.json`] = JSON.stringify(json, null, 4);
    if (u.info !== undefined) files[`${dir}/${file}.info`] = u.info;
  }
  if (options.conf !== undefined) files['BambuStudio.conf'] = options.conf;
  return memFs(files);
}

export function sidecar(baseId: string, settingId = 'PFUS0000000000000a'): string {
  return (
    `sync_info = \r\nuser_id = 1000000001\r\nsetting_id = ${settingId}\r\n` +
    `base_id = ${baseId}\r\nupdated_time = 1782278409\r\n`
  );
}

/** Copies a fixture to a fresh temp folder. Call the returned cleanup when done. */
export function tempFixture(name: FixtureName | OrcaFixtureName): {
  dir: string;
  cleanup: () => void;
} {
  const parent = mkdtempSync(join(tmpdir(), 'preset-doctor-'));
  const dir = join(parent, name === 'orca' ? 'OrcaSlicer' : 'BambuStudio');
  cpSync(fixtureRoot(name), dir, { recursive: true });
  return { dir, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}
