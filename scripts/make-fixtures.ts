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
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseJsonFile,
  serializeJsonFile,
  setJsonArrayStringItem,
  setJsonStringField,
} from '../packages/core/src/jsonFile.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

/** Studio's conf ends with "# MD5 checksum <md5 of the LF-normalized JSON>" (verified on 2.8). */
function synthesizeConf(syncUserPreset: boolean): string {
  const json = serializeJsonFile(
    { app: { sync_user_preset: syncUserPreset } },
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

// ---------- leak check ----------

const leaks: string[] = [];
const walk = (d: string): void => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else {
      const t = e.name + '\n' + fs.readFileSync(p, 'utf8');
      for (const real of accountMap.keys()) if (t.includes(real)) leaks.push(`${p}: account id`);
      for (const real of settingIdMap.keys()) if (t.includes(real)) leaks.push(`${p}: setting id`);
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

const readme = `# Test fixtures

Generated by \`npm run fixtures\` (scripts/make-fixtures.ts) from a live Bambu Studio folder
(system profile version ${String(bblIndex.version)}). Do not hand-edit; regenerate instead.

Each folder is a complete, minimal \`%APPDATA%\\BambuStudio\` root:
\`BambuStudio.conf\`, \`system/BBL.json\`, \`system/BBL/filament/**\`, \`user/<id>/filament/**\`.

## Privacy

- Account ids are replaced: the main account becomes \`1000000001\`, the second \`1000000002\`
  (folder names and \`user_id\` in sidecars).
- User \`setting_id\` values (\`PFUS...\`) are replaced with fake deterministic ids of the same length.
- \`BambuStudio.conf\` is synthesized, never copied: it holds only \`app.sync_user_preset\` plus the
  \`# MD5 checksum\` trailer Studio writes (MD5 of the LF-normalized JSON without the final newline).
  Readers must strip that trailer before \`JSON.parse\`.
- The generator fails if any real account id or real setting id appears in the output.

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
\`machine_list\` and \`process_list\` are empty. Every \`filament_list\` entry has its file.

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
R5_CLOUD_SYNC warning.
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
`;
fs.writeFileSync(path.join(outRoot, 'README.md'), readme, 'utf8');

const total = systemFiles.reduce((n, f) => n + Buffer.byteLength(f.text), 0);
console.log(
  `Wrote ${Object.keys(fixtures).length} fixtures to ${path.relative(repoRoot, outRoot)}: ` +
    `${systemFiles.length} system files (${Math.round(total / 1024)} KB each copy), ` +
    `${settingIdMap.size} setting ids anonymized.`,
);
