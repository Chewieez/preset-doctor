/**
 * Builds packages/core/src/__fixtures__/orca/ from a live OrcaSlicer folder.
 *
 *   node scripts/make-orca-fixture.ts [<OrcaSlicer folder>]     (default: %APPDATA%\OrcaSlicer)
 *
 * The live folder is only ever read. Only OrcaSlicer's public system profile files are copied
 * (byte for byte, with their whole inherits chains). OrcaSlicer.conf, every user preset and every
 * sidecar is synthesized here: the live conf holds personal paths and ids and is never copied.
 * The generator fails if the output contains any account id, the Windows user name, or a value
 * of the live conf's personal keys (read at run time only, never written anywhere).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { registerHooks } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Core's sources import each other as './x.js' (for tsc); point those at the .ts files so
// Node's type stripping can run them directly (as scripts/make-fixtures.ts does).
const coreSrc = pathToFileURL(path.join(repoRoot, 'packages', 'core', 'src') + path.sep).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(coreSrc) && /^\.\.?\/.*\.js$/.test(specifier)) {
      const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (fs.existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
    return next(specifier, context);
  },
});
const { parseJsonFile, serializeJsonFile } = await import('../packages/core/src/jsonFile.ts');

const fixturesDir = path.join(repoRoot, 'packages', 'core', 'src', '__fixtures__');
const outRoot = path.join(fixturesDir, 'orca');
const liveRoot = path.resolve(
  process.argv[2] ?? path.join(process.env.APPDATA ?? '', 'OrcaSlicer'),
);

if (!fs.existsSync(path.join(liveRoot, 'system', 'OrcaFilamentLibrary.json'))) {
  throw new Error(`Not an OrcaSlicer folder with JSON system presets: ${liveRoot}`);
}
const outRel = path.relative(liveRoot, outRoot);
if (!outRel.startsWith('..') && !path.isAbsolute(outRel)) {
  throw new Error('Output folder must not be inside the live folder');
}

// ---------- read-only access to the live folder ----------

const readLiveBytes = (...parts: string[]): Buffer =>
  fs.readFileSync(path.join(liveRoot, ...parts));
const readLive = (...parts: string[]): string => readLiveBytes(...parts).toString('utf8');

type ListKey = 'filament_list' | 'process_list' | 'machine_list';
interface IndexEntry {
  name: string;
  sub_path: string;
}
const VENDORS = ['OrcaFilamentLibrary', 'Custom', 'Elegoo'] as const;
type Vendor = (typeof VENDORS)[number];
const LIBRARY: Vendor = 'OrcaFilamentLibrary';

const indexes = new Map<Vendor, { text: string; json: Record<string, unknown> }>();
for (const v of VENDORS) {
  const text = readLive('system', `${v}.json`);
  indexes.set(v, { text, json: parseJsonFile(text).value as Record<string, unknown> });
}
const list = (v: Vendor, key: ListKey): IndexEntry[] =>
  (indexes.get(v)!.json[key] as IndexEntry[] | undefined) ?? [];

function presetFile(
  v: Vendor,
  key: ListKey,
  name: string,
): { rel: string; json: Record<string, unknown> } | undefined {
  const e = list(v, key).find((x) => x.name === name);
  if (!e) return undefined;
  const rel = `system/${v}/${e.sub_path.replace(/\\/g, '/')}`;
  return { rel, json: JSON.parse(readLive(...rel.split('/'))) as Record<string, unknown> };
}

// ---------- the system subset ----------

// Each preset plus its inherits chain: its own vendor first, then the library, as Orca resolves
// system parents (src/libslic3r/PresetBundle.cpp:7797-7826@v2.5.0).
const ROOTS: { vendor: Vendor; key: ListKey; names: string[] }[] = [
  {
    vendor: LIBRARY,
    key: 'filament_list',
    names: ['Generic PLA @System', 'Generic PETG @System', 'Generic ABS @System'],
  },
  {
    vendor: 'Custom',
    key: 'filament_list',
    names: ['Generic ABS @MyToolChanger', 'Generic PLA @MyToolChanger'],
  },
  {
    vendor: 'Custom',
    key: 'machine_list',
    names: [
      'MyToolChanger 0.2 nozzle',
      'MyToolChanger 0.4 nozzle',
      'MyToolChanger 0.6 nozzle',
      'MyToolChanger 0.8 nozzle',
    ],
  },
  { vendor: 'Elegoo', key: 'filament_list', names: ['Elegoo PLA @ECC'] },
  {
    vendor: 'Elegoo',
    key: 'process_list',
    names: ['0.20mm Standard @Elegoo CC 0.4 nozzle', '0.30mm Standard @Elegoo CC 0.6 nozzle'],
  },
  {
    vendor: 'Elegoo',
    key: 'machine_list',
    names: ['Elegoo Centauri Carbon 0.4 nozzle', 'Elegoo Centauri Carbon 0.6 nozzle'],
  },
];

const selected = new Map<string, Set<string>>(); // `${vendor}\u0000${key}` -> names
const pick = (v: Vendor, key: ListKey, name: string): void => {
  const k = `${v}\u0000${key}`;
  if (!selected.has(k)) selected.set(k, new Set());
  selected.get(k)!.add(name);
};
const isPicked = (v: Vendor, key: ListKey, name: string): boolean =>
  selected.get(`${v}\u0000${key}`)?.has(name) ?? false;

for (const r of ROOTS) {
  for (const name of r.names) {
    let vendor: Vendor = r.vendor;
    let current = name;
    for (let depth = 0; current !== '' && depth < 32; depth++) {
      let file = presetFile(vendor, r.key, current);
      if (!file && vendor !== LIBRARY) {
        vendor = LIBRARY;
        file = presetFile(vendor, r.key, current);
      }
      if (!file) throw new Error(`Missing system preset ${current} (${r.key})`);
      pick(vendor, r.key, current);
      for (const inc of (file.json.include as string[] | undefined) ?? []) pick(vendor, r.key, inc);
      current = typeof file.json.inherits === 'string' ? file.json.inherits : '';
    }
  }
}

interface OutFile {
  rel: string;
  data: string | Buffer;
}
const systemFiles: OutFile[] = [];
const LISTS: ListKey[] = ['filament_list', 'process_list', 'machine_list'];
for (const v of VENDORS) {
  const { text, json } = indexes.get(v)!;
  const trimmed: Record<string, unknown> = { ...json };
  for (const key of LISTS) {
    if (!Array.isArray(json[key])) continue;
    const kept = list(v, key).filter((e) => isPicked(v, key, e.name));
    trimmed[key] = kept;
    for (const e of kept) {
      const rel = `system/${v}/${e.sub_path.replace(/\\/g, '/')}`;
      systemFiles.push({ rel, data: readLiveBytes(...rel.split('/')) });
    }
  }
  if (Array.isArray(json['machine_model_list'])) trimmed['machine_model_list'] = [];
  const format = parseJsonFile(text).format;
  systemFiles.push({ rel: `system/${v}.json`, data: serializeJsonFile(trimmed, format) });
}

// ---------- OrcaSlicer.conf (synthesized) ----------

/** JSON, then "# MD5 checksum <md5 of the LF-normalized JSON>", as Orca writes it. */
function synthesizeConf(value: Record<string, unknown>): string {
  const json = serializeJsonFile(value, {
    indent: '    ',
    eol: '\r\n',
    trailingNewline: true,
    bom: false,
    canonical: true,
  });
  const md5 = createHash('md5')
    .update(json.replace(/\r\n/g, '\n').replace(/\n$/, ''))
    .digest('hex')
    .toUpperCase();
  return `${json}# MD5 checksum ${md5}\r\n`;
}

const CC04 = 'Elegoo Centauri Carbon 0.4 nozzle';
const conf = synthesizeConf({
  app: { preset_folder: '', sync_user_preset: false },
  header: 'OrcaSlicer 2.3.2-rc',
  models: [{ model: 'Elegoo Centauri Carbon', nozzle_diameter: '0.4;0.6', vendor: 'Elegoo' }],
  orca_presets: [{ machine: CC04, process: '0.20mm Standard @Elegoo CC 0.4 nozzle' }],
  presets: { machine: CC04 },
});

// ---------- user presets (synthesized) ----------

type PresetType = 'filament' | 'process' | 'machine';
const LIST_OF: Record<PresetType, ListKey> = {
  filament: 'filament_list',
  process: 'process_list',
  machine: 'machine_list',
};
const SETTINGS_ID_KEY: Record<PresetType, string> = {
  filament: 'filament_settings_id',
  process: 'print_settings_id',
  machine: 'printer_settings_id',
};
const SIDE_PREFIX: Record<PresetType, string> = {
  filament: 'PFUS',
  process: 'PPUS',
  machine: 'PMUS',
};
const META_KEYS = new Set([
  'type',
  'name',
  'inherits',
  'from',
  'setting_id',
  'instantiation',
  'description',
  'include',
  'renamed_from',
  'compatible_printers',
  'compatible_printers_condition',
  'printer_model',
  'printer_variant',
  'default_filament_profile',
  'default_print_profile',
  'upward_compatible_machine',
  'filament_id',
  'filament_settings_id',
  'print_settings_id',
  'printer_settings_id',
  'version',
]);

interface UserSpec {
  account: 'default' | '1000000001';
  type: PresetType;
  file: string;
  inherits: string;
  /** A system preset whose own settings give the 2-3 override keys. */
  keysFrom: { vendor: Vendor; name: string };
  /** Write a .info sidecar (with this sync_info). Omitted: no sidecar. */
  sync?: string;
  expect: string;
}

const USERS: UserSpec[] = [
  {
    account: 'default',
    type: 'filament',
    file: 'Lib Child',
    inherits: 'Generic PLA @System',
    keysFrom: { vendor: LIBRARY, name: 'Generic PLA @System' },
    sync: '',
    expect: 'ok (library parent)',
  },
  {
    account: 'default',
    type: 'filament',
    file: 'Toolchanger Child',
    inherits: 'Generic PLA @MyToolChanger',
    keysFrom: { vendor: 'Custom', name: 'Generic PLA @MyToolChanger' },
    sync: '',
    expect:
      'loads (a Custom parent that inherits the library); R2: only for the MyToolChanger printers',
  },
  {
    account: 'default',
    type: 'filament',
    file: 'Renamed',
    inherits: 'My Generic ABS @MyToolChanger',
    keysFrom: { vendor: 'Custom', name: 'Generic ABS @MyToolChanger' },
    sync: '',
    expect:
      'R1 note "Parent found under its new name": `Generic ABS @MyToolChanger`, not pre-selected',
  },
  {
    account: 'default',
    type: 'filament',
    file: 'Generic Fallback',
    inherits: 'Generic PLA @Elegoo Nonexistent',
    keysFrom: { vendor: LIBRARY, name: 'Generic PLA @System' },
    expect: 'R1 note "OrcaSlicer substitutes a generic parent" (`Generic PLA @System`)',
  },
  {
    account: 'default',
    type: 'filament',
    file: 'Case Only',
    inherits: 'elegoo pla @ECC',
    keysFrom: { vendor: 'Elegoo', name: 'Elegoo PLA @ECC' },
    sync: '',
    expect: 'R1 hidden; `Elegoo PLA @ECC` high and pre-selected',
  },
  {
    account: 'default',
    type: 'filament',
    file: 'Brand Off',
    inherits: 'Creality Hyper PLA @Creality K1',
    keysFrom: { vendor: LIBRARY, name: 'Generic PLA @System' },
    expect: 'R1 hidden, with the "printer brand turned off" hint; nothing pre-selected',
  },
  {
    account: 'default',
    type: 'filament',
    file: 'Library Gone',
    inherits: 'Panchroma PLA Stain @System',
    keysFrom: { vendor: LIBRARY, name: 'Generic PLA @System' },
    expect: 'R1 hidden (removed from the library in 2.3.2), no replacement, no brand hint',
  },
  {
    account: 'default',
    type: 'process',
    file: 'CC Copy',
    inherits: '0.20mm Standard @Elegoo CC 0.4 nozzle',
    keysFrom: { vendor: 'Elegoo', name: '0.20mm Standard @Elegoo CC 0.4 nozzle' },
    sync: '',
    expect: 'ok, for the selected printer',
  },
  {
    account: 'default',
    type: 'process',
    file: 'CC 06 Copy',
    inherits: '0.30mm Standard @Elegoo CC 0.6 nozzle',
    keysFrom: { vendor: 'Elegoo', name: '0.30mm Standard @Elegoo CC 0.6 nozzle' },
    sync: '',
    expect: 'ok, for another added printer (counted in the grouped note)',
  },
  {
    account: 'default',
    type: 'machine',
    file: 'My CC',
    inherits: CC04,
    keysFrom: { vendor: 'Elegoo', name: CC04 },
    sync: '',
    expect: 'ok',
  },
  {
    account: '1000000001',
    type: 'filament',
    file: 'Plain',
    inherits: 'Generic PETG @System',
    keysFrom: { vendor: LIBRARY, name: 'Generic PETG @System' },
    sync: '',
    expect: 'ok (second account; account ids are strings)',
  },
];

const fakeHex = (seed: string, len: number): string =>
  createHash('sha256').update(seed).digest('hex').slice(0, len);

function sidecar(
  account: string,
  type: PresetType,
  file: string,
  sync: string,
  baseId: string,
): string {
  const settingId =
    SIDE_PREFIX[type] + fakeHex(`preset-doctor-orca-${account}-${type}-${file}`, 14);
  const userId = account === 'default' ? '' : account;
  return (
    `sync_info = ${sync}\r\nuser_id = ${userId}\r\nsetting_id = ${settingId}\r\n` +
    `base_id = ${baseId}\r\nupdated_time = 1782278409\r\n`
  );
}

function buildUser(u: UserSpec): OutFile[] {
  const source = presetFile(u.keysFrom.vendor, LIST_OF[u.type], u.keysFrom.name);
  if (!source) throw new Error(`Missing ${u.keysFrom.name}`);
  const overrides = Object.keys(source.json)
    .filter((k) => !META_KEYS.has(k))
    .slice(0, 3);
  const json: Record<string, unknown> = {
    from: 'User',
    inherits: u.inherits,
    name: u.file,
    [SETTINGS_ID_KEY[u.type]]: u.type === 'filament' ? [u.file] : u.file,
    version: '2.3.2.0',
  };
  for (const k of overrides) json[k] = source.json[k];
  const sorted = Object.fromEntries(
    Object.keys(json)
      .sort()
      .map((k) => [k, json[k]]),
  );
  const text = serializeJsonFile(sorted, {
    indent: '    ',
    eol: '\n',
    trailingNewline: false,
    bom: false,
    canonical: true,
  });
  const rel = `user/${u.account}/${u.type}/${u.file}`;
  const out: OutFile[] = [{ rel: `${rel}.json`, data: text }];
  if (u.sync !== undefined) {
    const baseId = typeof source.json.setting_id === 'string' ? source.json.setting_id : '';
    out.push({ rel: `${rel}.info`, data: sidecar(u.account, u.type, u.file, u.sync, baseId) });
  }
  return out;
}

const userFiles: OutFile[] = [
  ...USERS.flatMap(buildUser),
  // A preset Orca deleted while synced: only the sidecar is left, marked for the cloud
  // (src/libslic3r/Preset.cpp:762-781@v2.5.0). Never a row, never restored on its own.
  {
    rel: 'user/default/filament/Lone.info',
    data: sidecar('default', 'filament', 'Lone', 'delete', 'OGFSA04'),
  },
  // Orca's own cache file in user/; not an account.
  { rel: 'user/hints.cereal', data: 'synthesized placeholder\n' },
  // Orca copies user/ here on the first start of each version and never reads it again.
  { rel: 'user_backup-v2.3.2-rc/default/filament/.gitkeep', data: '' },
];

// ---------- write ----------

fs.rmSync(outRoot, { recursive: true, force: true });
for (const f of [...systemFiles, ...userFiles, { rel: 'OrcaSlicer.conf', data: conf }]) {
  const abs = path.join(outRoot, ...f.rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, f.data);
}

// ---------- leak check ----------

// Strings that must never reach the repo, read from the live folders at run time only.
const forbidden = new Set<string>();
const addForbidden = (v: unknown): void => {
  if (typeof v === 'string' && v.trim().length >= 4) forbidden.add(v.trim());
};
addForbidden(os.userInfo().username);
for (const dir of [
  path.join(liveRoot, 'user'),
  path.join(path.dirname(liveRoot), 'BambuStudio', 'user'),
]) {
  if (!fs.existsSync(dir)) continue;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== 'default') addForbidden(e.name);
  }
}
const liveConfText = readLive('OrcaSlicer.conf');
const liveConf = JSON.parse(liveConfText.slice(0, liveConfText.lastIndexOf('}') + 1)) as Record<
  string,
  unknown
>;
const app = (liveConf.app ?? {}) as Record<string, unknown>;
for (const key of ['slicer_uuid', 'download_path', 'last_backup_path', 'user_id', 'access_code']) {
  addForbidden(app[key]);
}
for (const v of Object.values(app)) {
  // Any personal path: the part after "Users\" is the account's folder name.
  if (typeof v === 'string') addForbidden(/[\\/]Users[\\/]([^\\/]+)/i.exec(v)?.[1]);
}

const leaks: string[] = [];
const walk = (d: string): void => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else {
      const t = (e.name + '\n' + fs.readFileSync(p, 'utf8')).toLowerCase();
      for (const s of forbidden) if (t.includes(s.toLowerCase())) leaks.push(`${p}: private value`);
    }
  }
};
walk(outRoot);
if (leaks.length) throw new Error(`Private values leaked:\n${leaks.join('\n')}`);

// ---------- README ----------

const version = String(indexes.get(LIBRARY)!.json.version);
const rows = USERS.map(
  (u) =>
    `| user/${u.account}/${u.type}/${u.file}.json${u.sync === undefined ? ' (no sidecar)' : ''} | \`${u.inherits}\` | ${u.expect} |`,
);
const systemNames = ROOTS.flatMap((r) => r.names.map((n) => `- \`${n}\` (${r.vendor})`));
const readme = `# orca/ fixture

Generated by \`node scripts/make-orca-fixture.ts\` from a live OrcaSlicer folder (system profiles
version ${version}). Do not hand-edit; regenerate instead. A complete, minimal
\`%APPDATA%\\OrcaSlicer\` root.

## System side

OrcaSlicer's public profile files, copied byte for byte: \`system/OrcaFilamentLibrary.json\`,
\`Custom.json\` and \`Elegoo.json\`, each trimmed to the entries below plus their whole inherits
chains (own vendor first, then the library), in the original list order; \`machine_model_list\`
is emptied. The listed presets:

${systemNames.join('\n')}

## OrcaSlicer.conf

Synthesized, never copied (the live one holds personal paths and ids): \`header\`
(\`OrcaSlicer 2.3.2-rc\`), \`app.preset_folder\` and \`app.sync_user_preset\`, \`models\`
(Elegoo Centauri Carbon, 0.4 and 0.6 nozzles), \`presets.machine\` (\`${CC04}\`) and
\`orca_presets\` (its process), plus the \`# MD5 checksum\` trailer.

## User side

Synthesized: \`from\`, \`inherits\`, \`name\`, the settings id, \`version\` and the first three
settings of a system preset; sorted keys, 4-space indent, LF without a final newline. Sidecars
use fake \`PFUS\`/\`PPUS\`/\`PMUS\` ids; \`user_id\` is empty for \`default\` (logged out).

| Preset file | \`inherits\` | Expected |
|---|---|---|
${rows.join('\n')}

Also: \`user/default/filament/Lone.info\` (\`sync_info = delete\`, no \`.json\`): never a row, kept in
backups, and never restored on its own. \`user/hints.cereal\` is a file, not an account.
\`user_backup-v2.3.2-rc/\` is Orca's own copy of \`user/\`; it is neither scanned nor backed up.

## Privacy

Account ids are \`default\` and \`1000000001\`. The generator fails if the output contains the
Windows user name, an account folder name of the live OrcaSlicer or Bambu Studio folder, or the
value of \`slicer_uuid\`, \`download_path\`, \`last_backup_path\` or any personal path in the live
conf. Those values are read at run time only.
`;
fs.writeFileSync(path.join(fixturesDir, 'README-orca.md'), readme, 'utf8');

console.log(
  `Wrote ${path.relative(repoRoot, outRoot)}: ${systemFiles.length} system files, ` +
    `${userFiles.length} user files, OrcaSlicer.conf.`,
);
