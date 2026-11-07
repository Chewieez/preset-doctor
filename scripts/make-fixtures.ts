/**
 * Builds packages/core/src/__fixtures__/ from a live Bambu Studio folder.
 *
 *   npm run fixtures [-- <BambuStudio folder>]     (default: %APPDATA%\BambuStudio)
 *
 * The live folder is only ever read. Output is anonymized: account ids become 1000000001,
 * 1000000002, ...; user setting ids (PFUS...) get fake deterministic values; BambuStudio.conf
 * is synthesized, never copied (the real one holds tokens and printer serials).
 * Every other byte of a copied preset is left alone so round-trip tests stay meaningful.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { registerHooks } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Core's sources import each other as './x.js' (for tsc); point those at the .ts files so
// Node's type stripping can run them directly (as scripts/r1-simulate.ts does).
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
const { parseJsonFile, serializeJsonFile, setJsonArrayStringItem, setJsonStringField } =
  await import('../packages/core/src/jsonFile.ts');
const outRoot = path.join(repoRoot, 'packages', 'core', 'src', '__fixtures__');
const liveRoot = path.resolve(
  process.argv[2] ?? path.join(process.env.APPDATA ?? '', 'BambuStudio'),
);

if (!fs.existsSync(path.join(liveRoot, 'system', 'BBL.json'))) {
  throw new Error(`Not a Bambu Studio folder: ${liveRoot}`);
}
const outRel = path.relative(liveRoot, outRoot);
if (!outRel.startsWith('..') && !path.isAbsolute(outRel)) {
  throw new Error('Output folder must not be inside the live folder');
}

// ---------- read-only access to the live folder ----------

const readLive = (...parts: string[]): string =>
  fs.readFileSync(path.join(liveRoot, ...parts), 'utf8');
const liveExists = (...parts: string[]): boolean => fs.existsSync(path.join(liveRoot, ...parts));

// ---------- anonymization ----------

const liveAccounts = fs
  .readdirSync(path.join(liveRoot, 'user'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
  .map((e) => ({
    id: e.name,
    count: liveExists('user', e.name, 'filament')
      ? fs.readdirSync(path.join(liveRoot, 'user', e.name, 'filament')).length
      : 0,
  }))
  .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
if (liveAccounts.length < 2) throw new Error('Expected at least two accounts in the live folder');

/** Main account (most presets) first. */
const accountMap = new Map(liveAccounts.map((a, i) => [a.id, String(1000000001 + i)]));
const MAIN = liveAccounts[0]!.id;
const SECOND = liveAccounts[1]!.id;

const settingIdMap = new Map<string, string>();
let fakeCounter = 0;
const fakeHex = (seed: string, len: number): string =>
  createHash('sha256').update(seed).digest('hex').slice(0, len);

function fakeSettingId(real: string): string {
  let fake = settingIdMap.get(real);
  if (!fake) {
    fake = 'PFUS' + fakeHex(`preset-doctor-fixture-${++fakeCounter}`, real.length - 4);
    settingIdMap.set(real, fake);
  }
  return fake;
}

function anonymize(text: string): string {
  let out = text.replace(/PFUS[0-9a-f]+/g, (m) => fakeSettingId(m));
  for (const [real, fake] of accountMap) out = out.replace(new RegExp(`\\b${real}\\b`, 'g'), fake);
  return out;
}

// ---------- system presets ----------

interface IndexEntry {
  name: string;
  sub_path: string;
}
const bblText = readLive('system', 'BBL.json');
const bbl = parseJsonFile(bblText);
const bblIndex = bbl.value as Record<string, unknown> & { filament_list: IndexEntry[] };
const subPathOf = new Map(bblIndex.filament_list.map((e) => [e.name, e.sub_path]));
const systemCache = new Map<string, { text: string; json: Record<string, unknown> }>();

function systemPreset(name: string): { text: string; json: Record<string, unknown> } | undefined {
  const sub = subPathOf.get(name);
  if (!sub) return undefined;
  let hit = systemCache.get(name);
  if (!hit) {
    const text = readLive('system', 'BBL', ...sub.split('/'));
    hit = { text, json: JSON.parse(text) as Record<string, unknown> };
    systemCache.set(name, hit);
  }
  return hit;
}

const NAME_RE = /^(.*) @BBL (\S+)(?: (\d+(?:\.\d+)?) nozzle)?$/;
function parseName(name: string): { stem: string; printer: string; nozzle?: string } | undefined {
  const m = NAME_RE.exec(name);
  if (!m) return undefined;
  return m[3] ? { stem: m[1]!, printer: m[2]!, nozzle: m[3] } : { stem: m[1]!, printer: m[2]! };
}

function resolvedCompat(name: string): string[] | undefined {
  for (let n: string | undefined = name, guard = 0; n && guard < 20; guard++) {
    const p = systemPreset(n);
    if (!p) return undefined;
    if (Array.isArray(p.json.compatible_printers)) return p.json.compatible_printers as string[];
    n = typeof p.json.inherits === 'string' ? p.json.inherits : undefined;
  }
  return undefined;
}

// ---------- user preset selection ----------

type Account = 'main' | 'second';
interface Copy {
  kind: 'copy';
  account: Account;
  /** Path under filament/, e.g. 'base/Foo.json'. */
  src: string;
  /** Rename the file (bytes unchanged unless transform is set). */
  dest?: string;
  info?: boolean; // default: copy the sidecar if it exists
  transform?: (text: string) => string;
}
interface Synthetic {
  kind: 'synthetic';
  /** Real preset used as the byte template. */
  template: string;
  name: string;
  inherits: string;
  note: string;
}
type Entry = Copy | Synthetic;

const realAccountId = (a: Account): string => (a === 'main' ? MAIN : SECOND);

const ORPHANS_06 = [
  'Anycubic Petg 06.json',
  'Anycubic Pla+ 06.json',
  'Bambu PLA Matte @BBL X2D 0.4 nozzle - Copy 06.json',
  'Cookie Cad Silk 06.json',
  'CookieCad TPU 06.json',
  'CookieCad TPU1 06.json',
  'cope 06.json',
  'Elegoo 95A Tpu 06.json',
  'Elegoo Petg Pro 06.json',
  'Elegoo Pla pro 06.json',
  'Flash Forge abs pro 06.json',
  'FLASHFORGE ABS ABS Pro - 0.4 nozzle 06.json',
  'Generic PLA @BBL X2D 0.4 nozzle - Copy 06.json',
  'Inland Petg 06.json',
  'Inland pla basic 06.json',
  'Overture ASA 06.json',
  'ProtoPast htpla 06.json',
  'sunlu pla+ 2.0 06.json',
];

const copy = (src: string, extra: Partial<Copy> = {}): Copy => ({
  kind: 'copy',
  account: 'main',
  src,
  ...extra,
});

const SYNTH_TEMPLATE = 'Anycubic Petg.json';

const fixtures: Record<string, { syncUserPreset: boolean; users: Record<string, Entry[]> }> = {
  healthy: {
    syncUserPreset: false,
    users: {
      main: [
        copy('Anycubic Petg.json'),
        copy('Anycubic Pla+.json'),
        copy('Cookie Cad Silk.json'),
        copy('CookieCad TPU.json'),
        copy('cope.json'),
        copy('Elegoo Petg-GF.json'),
        copy('Flash Forge abs pro.json'),
        copy('Overture ASA.json'),
        copy('Sunlu Easy PA.json'),
        copy('sunlu pla+ 2.0.json'),
        copy('base/Fiberon ASA-CF08 @Bambu Lab X2D 0.4 nozzle.json'),
        copy('base/Panchroma PLA Matte @Bambu Lab X2D 0.4 nozzle.json'),
        copy('base/OVERTURE SILK PLA Silk @BBL X2D.json'),
      ],
    },
  },
  'broken-r1': {
    syncUserPreset: true,
    users: {
      main: [
        ...ORPHANS_06.map((f) => copy(f)),
        copy('Anycubic Petg.json'),
        {
          kind: 'synthetic',
          template: SYNTH_TEMPLATE,
          name: 'Synthetic Stripped Suffix',
          inherits: 'Bambu PLA Basic @BBL X2D',
          note:
            'no nozzle size in the name, where every unsuffixed X2D preset is for 0.6/0.8, so ' +
            'the size is unsure and nothing is pre-selected (see the note below the table)',
        },
        {
          kind: 'synthetic',
          template: SYNTH_TEMPLATE,
          name: 'Synthetic Added Suffix',
          inherits: 'Bambu ABS @BBL X1C 0.4 nozzle',
          note: 'suffix added where the system name (X1C) has none',
        },
        {
          kind: 'synthetic',
          template: SYNTH_TEMPLATE,
          name: 'Synthetic Other Printer Only',
          inherits: 'Overture PLA @BBL X2D 0.4 nozzle',
          note: 'stem exists only for other printers (low tier)',
        },
        {
          kind: 'synthetic',
          template: SYNTH_TEMPLATE,
          name: 'Synthetic No Candidates',
          inherits: 'Unobtainium Filament @BBL X2D 0.4 nozzle',
          note: 'stem exists nowhere (no candidates)',
        },
        {
          kind: 'synthetic',
          template: SYNTH_TEMPLATE,
          name: 'Synthetic User Child',
          inherits: 'Anycubic Petg',
          note: 'parent is another user preset that exists (healthy)',
        },
      ],
    },
  },
  'broken-r4': {
    syncUserPreset: false,
    users: {
      main: [
        copy('Inland Petg.json'),
        copy('Biqu-morphlex.json'),
        copy('Elegoo Petg Pro.json'),
        copy('Elegoo Pla Galaxy.json'),
        copy('Elegoo Pla pro.json'),
        copy('test.json'),
        copy('Sunlu Wood PLA.json', { info: false }),
        copy('Inland Petg.json', {
          dest: 'Truncated Preset.json',
          transform: (t) => t.slice(0, Math.floor(t.length * 0.6)),
        }),
        copy('Overture ASA.json', {
          dest: 'Missing Name.json',
          transform: (t) => {
            const out = t.replace(/^[ \t]*"name": "[^"]*",\r?\n/m, '');
            if (out === t) throw new Error('name line not found');
            return out;
          },
        }),
      ],
    },
  },
  'multi-account': {
    syncUserPreset: false,
    users: {
      main: [
        copy('Anycubic Petg.json'),
        copy('cope.json'),
        copy('Inland Petg.json'),
        copy('Overture ASA.json'),
        copy('Sunlu Easy PA.json'),
        copy('base/Fiberon ASA-CF08 @Bambu Lab X2D 0.4 nozzle.json'),
      ],
      second: [
        copy('Anycubic Petg 06.json', { account: 'second' }),
        copy('Inland Petg 06.json', { account: 'second' }),
        copy('Overture ASA 06.json', { account: 'second' }),
      ],
      default: [],
    },
  },
};

// ---------- build ----------

interface OutFile {
  rel: string;
  text: string;
}

function buildUserFiles(entries: Entry[], accountKey: string): OutFile[] {
  const out: OutFile[] = [];
  const fakeAccount =
    accountKey === 'default' ? 'default' : accountMap.get(realAccountId(accountKey as Account))!;
  const base = `user/${fakeAccount}/filament`;
  for (const e of entries) {
    if (e.kind === 'copy') {
      const real = realAccountId(e.account);
      const srcParts = e.src.split('/');
      let text = readLive('user', real, 'filament', ...srcParts);
      if (e.transform) text = e.transform(text);
      const destRel = e.dest ? [...srcParts.slice(0, -1), e.dest].join('/') : e.src;
      out.push({ rel: `${base}/${destRel}`, text: anonymize(text) });
      const infoSrc = e.src.replace(/\.json$/, '.info');
      if (e.info !== false && liveExists('user', real, 'filament', ...infoSrc.split('/'))) {
        out.push({
          rel: `${base}/${destRel.replace(/\.json$/, '.info')}`,
          text: anonymize(readLive('user', real, 'filament', ...infoSrc.split('/'))),
        });
      }
    } else {
      const tpl = readLive('user', MAIN, 'filament', e.template);
      let text = setJsonStringField(tpl, 'name', e.name);
      text = setJsonStringField(text, 'inherits', e.inherits);
      text = setJsonArrayStringItem(text, 'filament_settings_id', 0, e.name);
      out.push({ rel: `${base}/${e.name}.json`, text: anonymize(text) });
      const infoTpl = anonymize(
        readLive('user', MAIN, 'filament', e.template.replace(/\.json$/, '.info')),
      );
      const synthId = 'PFUS' + fakeHex(`preset-doctor-synthetic-${e.name}`, 14);
      out.push({
        rel: `${base}/${e.name}.info`,
        text: infoTpl.replace(/^setting_id = .*$/m, `setting_id = ${synthId}`),
      });
    }
  }
  return out;
}

function presetParents(files: OutFile[]): string[] {
  return files
    .filter((f) => f.rel.endsWith('.json'))
    .flatMap((f) => {
      try {
        const v = JSON.parse(f.text) as { inherits?: unknown };
        return typeof v.inherits === 'string' && v.inherits !== '' ? [v.inherits] : [];
      } catch {
        return [];
      }
    });
}

const userFiles = new Map<string, OutFile[]>();
for (const [fixture, spec] of Object.entries(fixtures)) {
  const files: OutFile[] = [];
  for (const [acct, entries] of Object.entries(spec.users))
    files.push(...buildUserFiles(entries, acct));
  userFiles.set(fixture, files);
}

// Pick system presets: every parent's stem on the printers involved (plus H2D and X1C so the
// low-confidence tier sees realistic "other printer" variants), then their full inherit/include chains.
const allParents = [...userFiles.values()].flatMap(presetParents);
const stems = new Set<string>();
const printers = new Set<string>(['H2D', 'X1C']);
for (const p of allParents) {
  const parsed = parseName(p);
  if (parsed) {
    stems.add(parsed.stem);
    printers.add(parsed.printer);
  }
}
const selected = new Set<string>();
for (const e of bblIndex.filament_list) {
  const parsed = parseName(e.name);
  if (parsed && stems.has(parsed.stem) && printers.has(parsed.printer)) selected.add(e.name);
}
for (const p of allParents) if (subPathOf.has(p)) selected.add(p);
const queue = [...selected];
while (queue.length) {
  const name = queue.pop()!;
  const preset = systemPreset(name);
  if (!preset) throw new Error(`System index names a missing file: ${name}`);
  const deps = [
    preset.json.inherits,
    ...(Array.isArray(preset.json.include) ? preset.json.include : []),
  ];
  for (const d of deps) {
    if (typeof d === 'string' && d !== '' && !selected.has(d)) {
      if (!subPathOf.has(d)) throw new Error(`${name} depends on unknown preset ${d}`);
      selected.add(d);
      queue.push(d);
    }
  }
}

const systemFiles: OutFile[] = [];
for (const e of bblIndex.filament_list) {
  if (selected.has(e.name))
    systemFiles.push({ rel: `system/BBL/${e.sub_path}`, text: systemPreset(e.name)!.text });
}
const trimmedIndex = {
  ...bblIndex,
  machine_model_list: [],
  filament_list: bblIndex.filament_list.filter((e) => selected.has(e.name)),
  machine_list: [],
  process_list: [],
};
if (!bbl.format.canonical)
  console.warn('warning: live BBL.json is not canonical; it was reformatted');
systemFiles.push({ rel: 'system/BBL.json', text: serializeJsonFile(trimmedIndex, bbl.format) });

/**
 * Studio's conf ends with "# MD5 checksum <md5 of the LF-normalized JSON>" (verified on 2.8).
 * `extra` adds top-level sections; every value is written here, never copied from the live conf.
 */
function synthesizeConf(syncUserPreset: boolean, extra: Record<string, unknown> = {}): string {
  const json = serializeJsonFile(
    { app: { sync_user_preset: syncUserPreset }, ...extra },
    {
      indent: '    ',
      eol: '\r\n',
      trailingNewline: true,
      bom: false,
      canonical: true,
    },
  );
  const md5 = createHash('md5')
    .update(json.replace(/\r\n/g, '\n').replace(/\n$/, ''))
    .digest('hex')
    .toUpperCase();
  return `${json}# MD5 checksum ${md5}\r\n`;
}

// ---------- types-bambu: process and printer presets ----------

// System presets are Bambu's public profile files, copied byte for byte with their whole
// inherits and include chains. The user presets are synthesized: live process names are the
// user's own, and there are no live printer presets.
type IndexedType = 'process' | 'machine';
const TYPE_LIST: Record<IndexedType, string> = { process: 'process_list', machine: 'machine_list' };
const typeIndex = bblIndex as unknown as Record<string, IndexEntry[] | undefined>;
const typeSubPath: Record<IndexedType, Map<string, string>> = {
  process: new Map((typeIndex.process_list ?? []).map((e) => [e.name, e.sub_path])),
  machine: new Map((typeIndex.machine_list ?? []).map((e) => [e.name, e.sub_path])),
};
const typeCache = new Map<string, { text: string; json: Record<string, unknown> }>();
function typePreset(
  type: IndexedType,
  name: string,
): { text: string; json: Record<string, unknown> } {
  const sub = typeSubPath[type].get(name);
  if (!sub) throw new Error(`No ${type} system preset named ${name}`);
  const key = `${type}\u0000${name}`;
  let hit = typeCache.get(key);
  if (!hit) {
    const text = readLive('system', 'BBL', ...sub.split('/'));
    hit = { text, json: JSON.parse(text) as Record<string, unknown> };
    typeCache.set(key, hit);
  }
  return hit;
}

const TYPE_SYSTEM: Record<IndexedType, string[]> = {
  process: [
    '0.20mm Standard @BBL X1C',
    '0.20mm Standard @BBL X2D',
    '0.20mm High Quality @BBL X2D',
    '0.16mm Standard @BBL H2D',
    '0.20mm Standard @BBL A1M',
  ],
  machine: [
    'Bambu Lab X1 Carbon 0.4 nozzle',
    'Bambu Lab X2D 0.4 nozzle',
    'Bambu Lab X2D 0.6 nozzle',
    'Bambu Lab A1 mini 0.4 nozzle',
  ],
};

const typeSelected: Record<IndexedType, Set<string>> = { process: new Set(), machine: new Set() };
for (const type of ['process', 'machine'] as const) {
  const queue = [...TYPE_SYSTEM[type]];
  while (queue.length) {
    const name = queue.pop()!;
    if (typeSelected[type].has(name)) continue;
    typeSelected[type].add(name);
    const json = typePreset(type, name).json;
    const deps = [json.inherits, ...(Array.isArray(json.include) ? json.include : [])];
    for (const d of deps) if (typeof d === 'string' && d !== '') queue.push(d);
  }
}

const typesSystemFiles: OutFile[] = systemFiles.filter((f) => f.rel !== 'system/BBL.json');
for (const type of ['process', 'machine'] as const) {
  for (const e of typeIndex[TYPE_LIST[type]] ?? []) {
    if (typeSelected[type].has(e.name)) {
      typesSystemFiles.push({
        rel: `system/BBL/${e.sub_path}`,
        text: typePreset(type, e.name).text,
      });
    }
  }
}
const typesIndex = {
  ...trimmedIndex,
  machine_list: (typeIndex.machine_list ?? []).filter((e) => typeSelected.machine.has(e.name)),
  process_list: (typeIndex.process_list ?? []).filter((e) => typeSelected.process.has(e.name)),
};
typesSystemFiles.push({ rel: 'system/BBL.json', text: serializeJsonFile(typesIndex, bbl.format) });

const SETTINGS_ID_KEY: Record<IndexedType | 'filament', string> = {
  filament: 'filament_settings_id',
  process: 'print_settings_id',
  machine: 'printer_settings_id',
};
const SIDE_PREFIX: Record<IndexedType | 'filament', string> = {
  filament: 'PFUS',
  process: 'PPUS',
  machine: 'PMUS',
};
// Keys every system file has that a user preset never copies as an override.
const META_KEYS = new Set([
  'type',
  'name',
  'inherits',
  'from',
  'setting_id',
  'instantiation',
  'description',
  'include',
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

interface TypedUser {
  type: IndexedType | 'filament';
  /** Path under user/1000000001/<type>/, without .json. */
  file: string;
  /** "name" and settings id; default: the file name. */
  name?: string;
  /** Omitted: the key is written as "" (a root preset). */
  inherits?: string;
  /** System preset whose own settings provide the 2-3 override keys. */
  keysFrom: string;
  /** base_id in the sidecar: a system preset's name (its setting_id is used), or '' for empty. */
  baseIdOf?: string;
  extra?: Record<string, unknown>;
  crlf?: boolean;
  expect: string;
}

const TYPES_USER: TypedUser[] = [
  {
    type: 'filament',
    file: 'My PLA',
    inherits: 'Generic PLA @BBL X2D 0.4 nozzle',
    keysFrom: 'Generic PLA @BBL X2D 0.4 nozzle',
    baseIdOf: 'Generic PLA @BBL X2D 0.4 nozzle',
    expect: 'ok (a filament row, so mixed-type output is covered)',
  },
  {
    type: 'process',
    file: '0.20mm Standard @BBL X1C - Copy',
    inherits: '0.20mm Standard @BBL X1C',
    keysFrom: '0.20mm Standard @BBL X1C',
    baseIdOf: '0.20mm Standard @BBL X1C',
    crlf: true,
    expect: 'ok',
  },
  {
    type: 'process',
    file: 'Case Only',
    inherits: '0.20mm standard @BBL X1C',
    keysFrom: '0.20mm Standard @BBL X1C',
    baseIdOf: '0.20mm Standard @BBL X1C',
    expect: 'R1 high, pre-selected `0.20mm Standard @BBL X1C`',
  },
  {
    type: 'process',
    file: 'Added Suffix',
    inherits: '0.20mm Standard @BBL X2D 0.4 nozzle',
    keysFrom: '0.20mm Standard @BBL X2D',
    baseIdOf: '0.20mm Standard @BBL X2D',
    expect: 'R1 high (covers X2D 0.4), pre-selected `0.20mm Standard @BBL X2D`',
  },
  {
    type: 'process',
    file: 'Old Profile Word',
    inherits: '0.20mm Optimal @BBL X2D',
    keysFrom: '0.20mm Standard @BBL X2D',
    baseIdOf: '',
    expect:
      'R1 medium `0.20mm Standard @BBL X2D` and `0.20mm High Quality @BBL X2D`; nothing pre-selected',
  },
  {
    type: 'process',
    file: 'Old Code',
    inherits: '0.20mm Standard @BBL N1',
    keysFrom: '0.20mm Standard @BBL A1M',
    baseIdOf: '0.20mm Standard @BBL A1M',
    expect: 'R1 medium (raised by base_id) `0.20mm Standard @BBL A1M`; nothing pre-selected',
  },
  {
    type: 'process',
    file: 'No Candidates',
    inherits: '0.33mm Weird @BBL ZZZ',
    keysFrom: '0.20mm Standard @BBL X2D',
    baseIdOf: '',
    expect: 'R1, no candidates',
  },
  {
    type: 'process',
    file: 'Name Mismatch',
    name: 'Name Mismatch Old',
    inherits: '0.20mm Standard @BBL X2D',
    keysFrom: '0.20mm Standard @BBL X2D',
    baseIdOf: '0.20mm Standard @BBL X2D',
    expect: 'R4 rename to `Name Mismatch`, which also rewrites `print_settings_id`',
  },
  {
    type: 'process',
    file: 'Template Parent',
    inherits: 'fdm_process_common',
    keysFrom: '0.20mm Standard @BBL X2D',
    baseIdOf: '',
    expect: 'R1 (the parent is a template, not instantiable), no high candidate',
  },
  {
    type: 'machine',
    file: 'Bambu Lab X1 Carbon 0.4 nozzle - Copy',
    inherits: 'Bambu Lab X1 Carbon 0.4 nozzle',
    keysFrom: 'Bambu Lab X1 Carbon 0.4 nozzle',
    baseIdOf: 'Bambu Lab X1 Carbon 0.4 nozzle',
    expect: 'ok',
  },
  {
    type: 'machine',
    file: 'Case Only Printer',
    inherits: 'Bambu Lab X1 carbon 0.4 nozzle',
    keysFrom: 'Bambu Lab X1 Carbon 0.4 nozzle',
    baseIdOf: 'Bambu Lab X1 Carbon 0.4 nozzle',
    expect: 'R1 high `Bambu Lab X1 Carbon 0.4 nozzle`, **not** pre-selected',
  },
  {
    type: 'machine',
    file: 'Old Model Name',
    inherits: 'Bambu Lab N1 0.4 nozzle',
    keysFrom: 'Bambu Lab A1 mini 0.4 nozzle',
    baseIdOf: 'Bambu Lab A1 mini 0.4 nozzle',
    expect: 'R1 medium `Bambu Lab A1 mini 0.4 nozzle` (from base_id), not pre-selected',
  },
  {
    type: 'machine',
    file: 'base/My Printer 0.4 nozzle',
    keysFrom: 'Bambu Lab X1 Carbon 0.4 nozzle',
    extra: { printer_model: 'My Printer', printer_variant: '0.4' },
    expect: 'ok, `Custom printer, not based on another preset`',
  },
];

function systemJson(type: IndexedType | 'filament', name: string): Record<string, unknown> {
  return type === 'filament' ? systemPreset(name)!.json : typePreset(type, name).json;
}

function settingIdOf(type: IndexedType | 'filament', name: string): string {
  const id = systemJson(type, name).setting_id;
  if (typeof id !== 'string') throw new Error(`${name} has no setting_id`);
  return id;
}

function buildTypedUser(u: TypedUser): OutFile[] {
  const name = u.name ?? u.file.split('/').pop()!;
  const source = systemJson(u.type, u.keysFrom);
  const overrides = Object.keys(source)
    .filter((k) => !META_KEYS.has(k))
    .slice(0, 3);
  const json: Record<string, unknown> = {
    from: 'User',
    inherits: u.inherits ?? '',
    name,
    [SETTINGS_ID_KEY[u.type]]: u.type === 'filament' ? [name] : name,
    version: '2.8.0.6',
    ...u.extra,
  };
  for (const k of overrides) json[k] = source[k];
  const sorted = Object.fromEntries(
    Object.keys(json)
      .sort()
      .map((k) => [k, json[k]]),
  );
  const text = serializeJsonFile(sorted, {
    indent: '    ',
    eol: u.crlf ? '\r\n' : '\n',
    trailingNewline: u.crlf === true,
    bom: false,
    canonical: true,
  });
  const rel = `user/1000000001/${u.type}/${u.file}`;
  const baseId = u.baseIdOf ? settingIdOf(u.type, u.baseIdOf) : '';
  const settingId = SIDE_PREFIX[u.type] + fakeHex(`preset-doctor-types-${u.type}-${u.file}`, 14);
  const info =
    `sync_info = \r\nuser_id = 1000000001\r\nsetting_id = ${settingId}\r\n` +
    `base_id = ${baseId}\r\nupdated_time = 1782278409\r\n`;
  return [
    { rel: `${rel}.json`, text },
    { rel: `${rel}.info`, text: info },
  ];
}

if (!selected.has('Generic PLA @BBL X2D 0.4 nozzle')) {
  throw new Error('The shared filament subset lost Generic PLA @BBL X2D 0.4 nozzle');
}
const typesUserFiles = TYPES_USER.flatMap(buildTypedUser);

// ---------- unsupported-bambu: R2/R3 (printers that aren't added) ----------

// The system subset is copied like types-bambu's: the listed presets plus their whole inherits
// and include chains. The conf is synthesized with only the keys R2/R3 read.
const UNSUPPORTED_SYSTEM: Record<IndexedType, string[]> = {
  process: [
    '0.20mm Standard @BBL X2D',
    '0.20mm Standard @BBL X1C',
    '0.16mm Standard @BBL H2D',
    '0.40mm Standard @BBL X2D 0.8 nozzle',
  ],
  machine: [
    'Bambu Lab X2D 0.4 nozzle',
    'Bambu Lab X2D 0.6 nozzle',
    'Bambu Lab X2D 0.8 nozzle',
    'Bambu Lab P1S 0.4 nozzle',
    'Bambu Lab X1 Carbon 0.4 nozzle',
    'Bambu Lab H2D 0.4 nozzle',
  ],
};
for (const name of [
  'Generic PLA @BBL X2D 0.4 nozzle',
  'Generic PLA @BBL H2D',
  'Generic PLA @base',
]) {
  if (!selected.has(name)) throw new Error(`The shared filament subset lost ${name}`);
}

const unsupportedSelected: Record<IndexedType, Set<string>> = {
  process: new Set(),
  machine: new Set(),
};
for (const type of ['process', 'machine'] as const) {
  const queue = [...UNSUPPORTED_SYSTEM[type]];
  while (queue.length) {
    const name = queue.pop()!;
    if (unsupportedSelected[type].has(name)) continue;
    unsupportedSelected[type].add(name);
    const json = typePreset(type, name).json;
    const deps = [json.inherits, ...(Array.isArray(json.include) ? json.include : [])];
    for (const d of deps) if (typeof d === 'string' && d !== '') queue.push(d);
  }
}
const unsupportedSystemFiles: OutFile[] = systemFiles.filter((f) => f.rel !== 'system/BBL.json');
for (const type of ['process', 'machine'] as const) {
  for (const e of typeIndex[TYPE_LIST[type]] ?? []) {
    if (unsupportedSelected[type].has(e.name)) {
      unsupportedSystemFiles.push({
        rel: `system/BBL/${e.sub_path}`,
        text: typePreset(type, e.name).text,
      });
    }
  }
}
const unsupportedIndex = {
  ...trimmedIndex,
  machine_list: (typeIndex.machine_list ?? []).filter((e) =>
    unsupportedSelected.machine.has(e.name),
  ),
  process_list: (typeIndex.process_list ?? []).filter((e) =>
    unsupportedSelected.process.has(e.name),
  ),
};
unsupportedSystemFiles.push({
  rel: 'system/BBL.json',
  text: serializeJsonFile(unsupportedIndex, bbl.format),
});

const UNSUPPORTED_CONF = {
  models: [
    { vendor: 'BBL', model: 'Bambu Lab X2D', nozzle_diameter: '0.4;0.6' },
    { vendor: 'BBL', model: 'Bambu Lab P1S', nozzle_diameter: '0.4' },
  ],
  presets: {
    machine: 'Bambu Lab X2D 0.4 nozzle',
    process: '0.20mm Standard @BBL X2D',
    filaments: ['Generic PLA @BBL X2D 0.4 nozzle'],
  },
};

const UNSUPPORTED_USER: TypedUser[] = [
  {
    type: 'process',
    file: 'On X2D',
    inherits: '0.20mm Standard @BBL X2D',
    keysFrom: '0.20mm Standard @BBL X2D',
    baseIdOf: '0.20mm Standard @BBL X2D',
    expect: '`selected`, no finding',
  },
  {
    type: 'process',
    file: 'On P1S',
    inherits: '0.20mm Standard @BBL X1C',
    keysFrom: '0.20mm Standard @BBL X1C',
    baseIdOf: '0.20mm Standard @BBL X1C',
    expect: '`other-printer` (P1S 0.4), counted in the R3 note',
  },
  {
    type: 'process',
    file: 'On H2D',
    inherits: '0.16mm Standard @BBL H2D',
    keysFrom: '0.16mm Standard @BBL H2D',
    baseIdOf: '0.16mm Standard @BBL H2D',
    expect: 'R2 `printer-not-added` (H2D 0.4)',
  },
  {
    type: 'process',
    file: 'On X2D 08',
    inherits: '0.40mm Standard @BBL X2D 0.8 nozzle',
    keysFrom: '0.40mm Standard @BBL X2D 0.8 nozzle',
    baseIdOf: '0.40mm Standard @BBL X2D 0.8 nozzle',
    expect: 'R3 `nozzle-not-added` (X2D 0.8; 0.4 and 0.6 added)',
  },
  {
    type: 'process',
    file: 'base/For My X2D',
    keysFrom: '0.20mm Standard @BBL X2D',
    extra: { compatible_printers: ['My X2D'] },
    expect: '`other-printer` (the user printer My X2D), counted in the note',
  },
  {
    type: 'filament',
    file: 'Unknown Printer',
    inherits: 'Generic PLA @BBL X2D 0.4 nozzle',
    keysFrom: 'Generic PLA @BBL X2D 0.4 nozzle',
    baseIdOf: 'Generic PLA @BBL X2D 0.4 nozzle',
    extra: { compatible_printers: ['Bambu Lab Q9 0.4 nozzle'] },
    expect: 'R2 `unknown-printers`, `guessed`',
  },
  {
    type: 'filament',
    file: 'Condition Only',
    inherits: 'Generic PLA @BBL X2D 0.4 nozzle',
    keysFrom: 'Generic PLA @BBL X2D 0.4 nozzle',
    baseIdOf: 'Generic PLA @BBL X2D 0.4 nozzle',
    extra: {
      compatible_printers: [],
      compatible_printers_condition: 'nozzle_diameter[0]==0.4',
    },
    expect: '`cant-tell` (condition), no finding',
  },
  {
    type: 'filament',
    file: 'Other Process',
    inherits: 'Generic PLA @BBL X2D 0.4 nozzle',
    keysFrom: 'Generic PLA @BBL X2D 0.4 nozzle',
    baseIdOf: 'Generic PLA @BBL X2D 0.4 nozzle',
    extra: { compatible_prints: ['0.12mm Fine @BBL X2D'] },
    expect: "`selected` with `process: 'mismatch'`, counted in the note",
  },
  {
    type: 'filament',
    file: 'base/My PLA @Bambu Lab H2D 0.4 nozzle',
    keysFrom: 'Generic PLA @BBL H2D',
    extra: { compatible_printers: [] },
    expect: 'the name rule gives `Bambu Lab H2D 0.4 nozzle`, so R2 `printer-not-added`',
  },
  {
    type: 'machine',
    file: 'My X2D',
    inherits: 'Bambu Lab X2D 0.4 nozzle',
    keysFrom: 'Bambu Lab X2D 0.4 nozzle',
    baseIdOf: 'Bambu Lab X2D 0.4 nozzle',
    expect: 'ok; printers are never judged, and this one counts as added',
  },
];
const unsupportedUserFiles = UNSUPPORTED_USER.flatMap(buildTypedUser);

// ---------- write ----------

for (const [fixture, spec] of Object.entries(fixtures)) {
  const dir = path.join(outRoot, fixture);
  fs.rmSync(dir, { recursive: true, force: true });
  const files: OutFile[] = [
    ...systemFiles,
    ...userFiles.get(fixture)!,
    { rel: 'BambuStudio.conf', text: synthesizeConf(spec.syncUserPreset) },
  ];
  if ('default' in spec.users) files.push({ rel: 'user/default/filament/.gitkeep', text: '' });
  for (const f of files) {
    const abs = path.join(dir, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.text, 'utf8');
  }
}
{
  const dir = path.join(outRoot, 'types-bambu');
  fs.rmSync(dir, { recursive: true, force: true });
  const files: OutFile[] = [
    ...typesSystemFiles,
    ...typesUserFiles,
    { rel: 'BambuStudio.conf', text: synthesizeConf(false) },
  ];
  for (const f of files) {
    const abs = path.join(dir, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.text, 'utf8');
  }
}
{
  const dir = path.join(outRoot, 'unsupported-bambu');
  fs.rmSync(dir, { recursive: true, force: true });
  const files: OutFile[] = [
    ...unsupportedSystemFiles,
    ...unsupportedUserFiles,
    { rel: 'BambuStudio.conf', text: synthesizeConf(false, UNSUPPORTED_CONF) },
  ];
  for (const f of files) {
    const abs = path.join(dir, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.text, 'utf8');
  }
}

// ---------- leak check ----------

// Every setting_id in a live user sidecar, of every type and account: none may reach the output.
// Read at run time only; never written anywhere.
const liveSettingIds = new Set<string>(settingIdMap.keys());
for (const a of fs.readdirSync(path.join(liveRoot, 'user'), { withFileTypes: true })) {
  if (!a.isDirectory()) continue;
  for (const sub of [
    'filament',
    'filament/base',
    'process',
    'process/base',
    'machine',
    'machine/base',
  ]) {
    const dir = path.join(liveRoot, 'user', a.name, ...sub.split('/'));
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.info')) continue;
      const id = /^setting_id = (\S+)/m.exec(fs.readFileSync(path.join(dir, f), 'utf8'))?.[1];
      if (id) liveSettingIds.add(id);
    }
  }
}

const leaks: string[] = [];
const walk = (d: string): void => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else {
      const t = e.name + '\n' + fs.readFileSync(p, 'utf8');
      for (const real of accountMap.keys()) if (t.includes(real)) leaks.push(`${p}: account id`);
      for (const real of liveSettingIds) if (t.includes(real)) leaks.push(`${p}: setting id`);
    }
  }
};
walk(outRoot);
if (leaks.length) throw new Error(`Private ids leaked:\n${leaks.join('\n')}`);

// ---------- README ----------

function modelFor(printer: string): string | undefined {
  const counts = new Map<string, number>();
  for (const e of bblIndex.filament_list) {
    if (parseName(e.name)?.printer !== printer || !selected.has(e.name)) continue;
    const own = systemPreset(e.name)!.json.compatible_printers;
    if (!Array.isArray(own)) continue;
    for (const c of own as string[]) {
      const model = /^(.*) \d+(?:\.\d+)? nozzle$/.exec(c)?.[1];
      if (model) counts.set(model, (counts.get(model) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** True when some instantiable unsuffixed preset for this printer is not 0.4-only. */
function unsuffixedVaries(printer: string, model: string): boolean {
  return trimmedIndex.filament_list.some((e) => {
    const p = parseName(e.name);
    if (!p || p.printer !== printer || p.nozzle !== undefined) return false;
    if (systemPreset(e.name)?.json.instantiation !== 'true') return false;
    const sizes = (resolvedCompat(e.name) ?? []).filter((c) => c.startsWith(`${model} `));
    return sizes.length > 0 && (sizes.length > 1 || sizes[0] !== `${model} 0.4 nozzle`);
  });
}

function orphanTable(files: OutFile[]): string {
  const userNames = new Set(
    files
      .filter((f) => f.rel.endsWith('.json'))
      .flatMap((f) => {
        try {
          return [(JSON.parse(f.text) as { name: string }).name];
        } catch {
          return [];
        }
      }),
  );
  const rows: string[] = [
    '| Preset file | Missing parent (`inherits`) | Same-printer system variants (resolved `compatible_printers`) | Expected high candidate |',
    '|---|---|---|---|',
  ];
  for (const f of files) {
    if (!f.rel.endsWith('.json')) continue;
    const v = JSON.parse(f.text) as { inherits?: string };
    const inh = v.inherits ?? '';
    if (!inh || (subPathOf.has(inh) && selected.has(inh)) || userNames.has(inh)) continue;
    const parsed = parseName(inh);
    const variants = parsed
      ? trimmedIndex.filament_list
          .map((e) => e.name)
          .filter((n) => {
            const p = parseName(n);
            return p && p.stem === parsed.stem && p.printer === parsed.printer;
          })
      : [];
    const model = parsed ? modelFor(parsed.printer) : undefined;
    // No size in the name: only safe to assume 0.4 when the profile's unsuffixed presets for
    // this printer are all 0.4-only; otherwise the user has to pick (R1's 'family' evidence).
    const unsure =
      parsed !== undefined &&
      parsed.nozzle === undefined &&
      model !== undefined &&
      unsuffixedVaries(parsed.printer, model);
    const target = model && !unsure ? `${model} ${parsed?.nozzle ?? '0.4'} nozzle` : undefined;
    const high = variants.filter((n) => target && resolvedCompat(n)?.includes(target));
    rows.push(
      `| ${path.posix.basename(f.rel)} | ${inh} | ${
        variants.map((n) => `${n} (${(resolvedCompat(n) ?? []).join(', ')})`).join('<br>') ||
        '(none)'
      } | ${unsure ? '(none: no nozzle size in the name, user picks)' : high.join(', ') || '(none)'} |`,
    );
  }
  return rows.join('\n');
}

const STRIPPED_NOTE = `Why \`Synthetic Stripped Suffix\` has no pre-selected fix: before the R1 nozzle hardening this
fixture expected \`Bambu PLA Basic @BBL X2D 0.4 nozzle\`, because a name without a size was taken
to mean 0.4. In this profile every unsuffixed X2D preset is the 0.6/0.8 variant (e.g.
\`Generic PETG @BBL X2D\`), so that guess could put a 0.6 or 0.8 nozzle on 0.4 settings: a
wrong-nozzle pick. Over the whole live profile, \`node scripts/r1-simulate.ts\` counted 150 such
pre-selections when an unsuffixed parent disappears (and 143 more for renamed ones). R1 now lists
each same-printer size as medium and asks the user to pick. The sidecar's \`base_id\`
(\`GFSG99_15\`, a Generic PETG preset) is for another filament, so it is ignored.`;

const synthNotes = (fixtures['broken-r1']!.users.main ?? [])
  .filter((e): e is Synthetic => e.kind === 'synthetic')
  .map((e) => `- \`${e.name}.json\` inherits \`${e.inherits}\`: ${e.note}.`)
  .join('\n');

function unsupportedTable(): string {
  const rows = ['| Preset file | Setup | Expected |', '|---|---|---|'];
  for (const u of UNSUPPORTED_USER) {
    const setup = [
      u.inherits ? `inherits \`${u.inherits}\`` : 'no `inherits`',
      ...Object.entries(u.extra ?? {}).map(([k, v]) => `own \`${k}: ${JSON.stringify(v)}\``),
    ].join(', ');
    rows.push(`| ${u.type}/${u.file}.json | ${setup} | ${u.expect} |`);
  }
  return rows.join('\n');
}

function typesTable(): string {
  const userNames = new Set(
    TYPES_USER.map((u) => `${u.type}\u0000${u.name ?? u.file.split('/').pop()!}`),
  );
  const rows = ['| Preset file | `inherits` | Parent exists | Expected |', '|---|---|---|---|'];
  for (const u of TYPES_USER) {
    const inh = u.inherits ?? '';
    const exists =
      inh === ''
        ? '(root preset)'
        : u.type === 'filament'
          ? selected.has(inh)
            ? 'yes'
            : 'no'
          : typeSelected[u.type].has(inh)
            ? typePreset(u.type, inh).json.instantiation === 'false'
              ? 'template only'
              : 'yes'
            : userNames.has(`${u.type}\u0000${inh}`)
              ? 'yes (user)'
              : 'no';
    const notes = [
      u.baseIdOf ? `base_id = setting_id of \`${u.baseIdOf}\`` : '',
      u.name ? `\`name\` = \`${u.name}\`` : '',
      u.crlf ? 'CRLF' : '',
    ].filter((s) => s !== '');
    rows.push(
      `| ${u.type}/${u.file}.json${notes.length ? ` (${notes.join('; ')})` : ''} | ${inh ? `\`${inh}\`` : '""'} | ${exists} | ${u.expect} |`,
    );
  }
  return rows.join('\n');
}

const readme = `# Test fixtures

Generated by \`npm run fixtures\` (scripts/make-fixtures.ts) from a live Bambu Studio folder
(system profile version ${String(bblIndex.version)}). Do not hand-edit; regenerate instead.

Each folder is a complete, minimal \`%APPDATA%\\BambuStudio\` root:
\`BambuStudio.conf\`, \`system/BBL.json\`, \`system/BBL/filament/**\`, \`user/<id>/filament/**\`.
\`types-bambu/\` also has \`system/BBL/process/**\`, \`system/BBL/machine/**\` and
\`user/1000000001/{process,machine}/**\`.
\`orca/\` is an OrcaSlicer root, made by \`scripts/make-orca-fixture.ts\`; see \`README-orca.md\`.

## Privacy

- Account ids are replaced: the main account becomes \`1000000001\`, the second \`1000000002\`
  (folder names and \`user_id\` in sidecars).
- User \`setting_id\` values (\`PFUS...\`) are replaced with fake deterministic ids of the same length.
- The process and printer user presets in \`types-bambu/\` are synthesized, never copied (live
  process names are the user's own); their sidecars use fake \`PPUS...\`/\`PMUS...\` ids.
- \`BambuStudio.conf\` is synthesized, never copied: it holds only \`app.sync_user_preset\` plus the
  \`# MD5 checksum\` trailer Studio writes (MD5 of the LF-normalized JSON without the final newline).
  Readers must strip that trailer before \`JSON.parse\`.
- The generator fails if any real account id, or any real setting id from a live sidecar of any
  preset type and account, appears in the output.

## Byte fidelity

Copied presets and sidecars are byte-identical to the live files apart from the id replacements.
Line endings vary on purpose (most user presets are LF without a trailing newline, some are CRLF
with one; sidecars are CRLF with a trailing space after empty values), so round-trip tests cover
both. A few hand-edited system templates (e.g. \`fdm_filament_common.json\`) are not in
JSON.stringify layout; \`parseJsonFile\` reports them as \`canonical: false\`. Fixes must use the
minimal-edit helpers (\`setJsonStringField\`), never a full re-serialize, for such files.

## Shared system subset (all fixtures)

${trimmedIndex.filament_list.length} of ${bblIndex.filament_list.length} system filament presets:
every stem used by a fixture parent (${[...stems].sort().join(', ')}) on printers
${[...printers].sort().join(', ')}, plus their full \`inherits\` and \`include\` chains
(\`@base\` presets, \`fdm_filament_*\` templates). \`BBL.json\` is trimmed to match:
\`filament_list\` keeps only included entries (original order), and \`machine_model_list\`,
\`machine_list\` and \`process_list\` are empty (except in \`types-bambu/\`, below). Every
\`filament_list\` entry has its file.

Note: in this profile version the X2D preset without a nozzle suffix (e.g. \`Generic PETG @BBL X2D\`)
is the 0.6/0.8 nozzle variant, while X1C's unsuffixed preset usually covers 0.4. Resolve
compatibility through the inherit chain; \`fdm_filament_common\` has \`compatible_printers: []\`.

## healthy/

\`BambuStudio.conf\`: \`sync_user_preset: false\`.
\`user/1000000001/filament/\`: 10 presets whose parent exists, each with a \`.info\` sidecar, and
3 wizard presets in \`base/\` (\`inherits: ""\`, own \`compatible_printers\`), with sidecars.

Expected: no findings at all.

## broken-r1/

\`BambuStudio.conf\`: \`sync_user_preset: true\` (as on the real machine), so expect one scan-level
R5_CLOUD_SYNC note (severity \`info\`).
\`user/1000000001/filament/\`:

- The 18 real \`... 06.json\` orphans (no sidecars, as on disk). They also carry their own
  \`compatible_printers: ["Bambu Lab X2D 0.6 nozzle"]\`.
- \`Anycubic Petg.json\` (healthy, with sidecar): parent of the user-parent case.
- Synthetic presets, built from \`${SYNTH_TEMPLATE}\` by changing only \`name\`, \`inherits\` and
  \`filament_settings_id[0]\`; each has a sidecar with \`base_id = GFSG99_15\` (copied from the template):
${synthNotes}

Expected R1 findings (computed by the generator: same stem and printer, high when the resolved
\`compatible_printers\` contains "<model> <nozzle from the name> nozzle". A name without a size
means 0.4 only if every unsuffixed preset for that printer is 0.4-only; otherwise nothing is
pre-selected and the user picks):

${orphanTable(userFiles.get('broken-r1')!)}

${STRIPPED_NOTE}

Also expected: R4 "missing sidecar" (severity info) for the 18 \`06\` presets.

## broken-r4/

\`user/1000000001/filament/\`:

| File | Problem | Expected |
|---|---|---|
| Inland Petg.json | none (control) | no findings |
| Biqu-morphlex.json | \`name\` is "Biqu-Morphlex" (case only) | info, no fix |
| Elegoo Petg Pro.json | \`name\` is "Elegoo petg pro" (case only) | info, no fix |
| Elegoo Pla Galaxy.json | \`name\` is "Elegoo Pla galaxy" (case only) | info, no fix |
| Elegoo Pla pro.json | \`name\` is "Elegoo PLA PRO" (case only) | info, no fix |
| test.json | \`name\` is "test.json" (CRLF file). Studio saves such a name as test.json itself, so this is consistent | no findings |
| Sunlu Wood PLA.json | no \`.info\` sidecar | info |
| Truncated Preset.json | invalid JSON (copy of Inland Petg cut at 60%) | error |
| Missing Name.json | no \`name\` key (copy of Overture ASA with the line removed) | error |

## multi-account/

- \`user/1000000001/filament/\`: 5 healthy presets with sidecars + 1 wizard preset in \`base/\`.
- \`user/1000000002/filament/\`: 3 real \`06\` orphans from the second account, no sidecars
  (that account has none on disk).
- \`user/default/filament/\`: empty (holds only \`.gitkeep\` so git keeps the folder).

Expected: account list 1000000001 (6 presets), 1000000002 (3), default (0); default pick is the
account with the most presets. (Counts include \`base/\` presets.)

## types-bambu/

Process and printer presets. \`BambuStudio.conf\`: \`sync_user_preset: false\`. The system
filament subset is the shared one. On top of it come ${typesIndex.process_list.length} of ${(typeIndex.process_list ?? []).length} system process files and
${typesIndex.machine_list.length} of ${(typeIndex.machine_list ?? []).length} system printer files: these presets

${[...TYPE_SYSTEM.process, ...TYPE_SYSTEM.machine].map((n) => `- \`${n}\``).join('\n')}

plus their full \`inherits\` and \`include\` chains (\`fdm_process_*\` and \`fdm_machine_*\`
templates), copied byte for byte. \`process_list\` and \`machine_list\` keep only included entries
(original order).

The user presets are synthesized: \`from\`, \`inherits\`, \`name\`, the settings id
(\`print_settings_id\` / \`printer_settings_id\`, a plain string), \`version\`, and the first three
settings of a system preset as overrides; sorted keys, 4-space indent, LF without a final newline
(the X1C copy is CRLF with one). Every preset has a sidecar.

${typesTable()}

Expected: 8 hidden (6 process, 2 printer), 1 OK with notes, 4 OK; no warnings. Printer
candidates are never pre-selected.

## unsupported-bambu/

The "Unsupported" helper (R2/R3, report-only). The system filament subset is the shared one; on
top of it come ${unsupportedIndex.process_list.length} system process files and ${unsupportedIndex.machine_list.length} system printer files: these presets

${[...UNSUPPORTED_SYSTEM.process, ...UNSUPPORTED_SYSTEM.machine].map((n) => `- \`${n}\``).join('\n')}

plus their full \`inherits\` and \`include\` chains, copied byte for byte.

\`BambuStudio.conf\` is synthesized with only the keys R2/R3 read, plus the MD5 trailer:
\`app.sync_user_preset: false\`, \`models\` (Bambu Lab X2D with the 0.4 and 0.6 nozzles, Bambu
Lab P1S with 0.4) and \`presets\` (printer \`Bambu Lab X2D 0.4 nozzle\`, process
\`0.20mm Standard @BBL X2D\`, filament \`Generic PLA @BBL X2D 0.4 nozzle\`).

The user presets in \`user/1000000001/\` are synthesized like those of \`types-bambu/\`, with the
compatibility keys below added as their own settings:

${unsupportedTable()}

Expected: 4 unsupported (2 R2 filament, 1 R2 and 1 R3 process), 6 OK; no warnings. One
scan-level R3_NOT_FOR_SELECTION note counts 1 filament (other process) and 2 process presets.
`;
fs.writeFileSync(path.join(outRoot, 'README.md'), readme, 'utf8');

const total = systemFiles.reduce((n, f) => n + Buffer.byteLength(f.text), 0);
console.log(
  `Wrote ${Object.keys(fixtures).length + 2} fixtures to ${path.relative(repoRoot, outRoot)}: ` +
    `${systemFiles.length} system files (${Math.round(total / 1024)} KB each copy), ` +
    `${settingIdMap.size} setting ids anonymized.`,
);
