// Test-only helpers (excluded from the build): tiny Bambu Studio folders in memory, and temp
// copies of fixtures for tests that write.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memFs, type MemFs } from '../memFs.js';
import { fixtureRoot, type FixtureName } from './fixtures.js';

export interface FakeSystemPreset {
  name: string;
  inherits?: string;
  compatible_printers?: string[];
  setting_id?: string;
  instantiation?: 'true' | 'false';
}

export interface FakeUserPreset {
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

/** A Studio folder in memory: system/BBL.json + preset files, and user/<account>/filament. */
export function fakeStudio(
  system: FakeSystemPreset[],
  user: FakeUserPreset[],
  options: { account?: string; version?: string; conf?: string } = {},
): MemFs {
  const account = options.account ?? '1000000001';
  const files: Record<string, string> = {
    'system/BBL.json': JSON.stringify({
      name: 'Bambulab',
      version: options.version ?? '02.08.00.06',
      filament_list: system.map((p) => ({ name: p.name, sub_path: `filament/${p.name}.json` })),
    }),
  };
  for (const p of system) {
    files[`system/BBL/filament/${p.name}.json`] = JSON.stringify(
      { type: 'filament', from: 'system', instantiation: 'true', inherits: '', ...p },
      null,
      4,
    );
  }
  for (const u of user) {
    const file = u.file ?? u.name ?? 'Unnamed';
    const dir = `user/${account}/filament${u.base ? '/base' : ''}`;
    const json: Record<string, unknown> = { from: 'User', ...u.extra };
    if (u.name !== undefined) json['filament_settings_id'] = [u.name];
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
export function tempFixture(name: FixtureName): { dir: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), 'preset-doctor-'));
  const dir = join(parent, 'BambuStudio');
  cpSync(fixtureRoot(name), dir, { recursive: true });
  return { dir, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}
