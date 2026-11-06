/**
 * Replays real Bambu profile renames against R1: for each pair of consecutive Bambu Studio
 * releases, every instantiable filament preset that disappeared becomes the parent of a synthetic
 * user preset, and Preset Doctor's scan runs against the newer release's system folder.
 *
 *   node scripts/r1-history.ts extract <BambuStudio clone> <history dir> <tag | folder=rev>...
 *        Offline. Writes <history dir>/<tag>/system/BBL.json and system/BBL/filament/** from the
 *        clone with `git ls-tree` + `git cat-file --batch`, with GIT_NO_LAZY_FETCH=1 so git never
 *        goes to the network: fetch the blobs first (see docs/r1-history.md).
 *   node scripts/r1-history.ts run <history dir> [--tags a,b,c | --pairs a:b,c:d] [--json <file>] [--list]
 *        Offline, read-only. Pairs consecutive --tags in the order given (default: every folder
 *        in <history dir> that has system/BBL.json, sorted by name), or exactly the --pairs,
 *        and prints one row per pair plus totals.
 *        --json writes every case; --list prints each WRONG pre-selection and each case whose
 *        true successor was not a candidate.
 *
 * Presets are named as Studio names them: by the "name" inside each file, which in a few old
 * profiles differs from the BBL.json entry (PresetBundle.cpp:6631@v02.09.01.70).
 *
 * Truth for a removed preset R (from the old release) is computed from the profile data, not
 * from names: R's "required" compat is its effective compatible_printers in the old release.
 * A preset S in the new release is an acceptable fix when it is instantiable, has R's effective
 * filament_id and its effective compatible_printers include every required entry. The true
 * successor is the acceptable preset with R's setting_id when there is one, else the only
 * acceptable preset; several acceptable presets are "multi" (any of them is right). With none:
 * "split" (same filament, but the required nozzles are now spread over several presets, so the
 * right one depends on the user's nozzle), "partial" (same filament, some nozzles gone) or
 * "none" (no preset with that filament_id for that printer).
 *
 * Each case runs in six variants: the user preset's compatible_printers absent, copied whole from
 * R, or one entry of R's list at a time (the right fix then only has to cover that entry); each
 * with and without a .info sidecar whose base_id is R's setting_id (what Studio writes). A
 * pre-selection is correct when it is an acceptable fix, WRONG otherwise.
 *
 * Never reads or writes %APPDATA%: paths under it are refused.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Core's sources import each other as './x.js' (for tsc); point those at the .ts files so
// Node's type stripping can run them directly (same hook as scripts/r1-simulate.ts).
const coreSrc = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'core', 'src') +
    path.sep,
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(coreSrc) && /^\.\.?\/.*\.js$/.test(specifier)) {
      const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
    return next(specifier, context);
  },
});

const { memFs } = await import('../packages/core/src/memFs.ts');
const { scan } = await import('../packages/core/src/scan.ts');
const { loadSystemIndexes } = await import('../packages/core/src/systemIndex.ts');
const { parsePresetName } = await import('../packages/core/src/names.ts');
const { readSystemCopy } = await import('../packages/core/src/testing/r1Simulation.ts');
const { RULE_IDS } = await import('../packages/core/src/types.ts');
const { stripBom } = await import('../packages/core/src/jsonFile.ts');
type SystemIndex = Awaited<ReturnType<typeof loadSystemIndexes>>;
type Candidate = import('../packages/core/src/types.ts').Candidate;

const ACCOUNT = '1000000001';

function refuseAppData(p: string): string {
  const abs = path.resolve(p);
  const appData = process.env['APPDATA'];
  if (
    appData &&
    (abs + path.sep).toLowerCase().startsWith(path.resolve(appData).toLowerCase() + path.sep)
  ) {
    console.error(`Refusing a path under %APPDATA% (live Studio data): ${abs}`);
    process.exit(2);
  }
  return abs;
}

// ---------------------------------------------------------------------------------------------
// extract

/**
 * The folder <out>/<folder> that extract replaces. <folder> must be one plain name (no path
 * separator, drive colon, "." or ".."), so the recursive delete can't leave <out>.
 */
function extractDest(out: string, folder: string): string {
  if (folder === '' || folder === '.' || folder === '..' || /[/\\:]/.test(folder)) {
    throw new Error(`Bad folder name "${folder}": use one plain name, e.g. v02.09.01.70=<rev>`);
  }
  const base = path.resolve(out);
  const dest = path.resolve(base, folder);
  if (path.dirname(dest) !== base) throw new Error(`Folder "${folder}" is not inside ${base}`);
  return dest;
}

async function extract(repo: string, out: string, tags: string[]): Promise<void> {
  const env = { ...process.env, GIT_NO_LAZY_FETCH: '1' };
  for (const spec of tags) {
    // "<folder>=<rev>" extracts <rev> into <out>/<folder>; a bare tag uses the tag as both.
    const eq = spec.indexOf('=');
    const tag = eq < 0 ? spec : spec.slice(eq + 1);
    const folder = eq < 0 ? spec : spec.slice(0, eq);
    if (tag === '' || tag.startsWith('-')) throw new Error(`Bad revision "${tag}" in "${spec}"`);
    // Checked before anything is read or deleted.
    const dest = refuseAppData(extractDest(out, folder));
    const ls = execFileSync(
      'git',
      [
        '-C',
        repo,
        'ls-tree',
        '-r',
        '-z',
        tag,
        '--',
        'resources/profiles/BBL.json',
        'resources/profiles/BBL/filament',
      ],
      { env, maxBuffer: 1 << 28 },
    ).toString('utf8');
    const items = ls
      .split('\0')
      .filter(Boolean)
      .map((l) => {
        const [meta = '', p = ''] = l.split('\t');
        return { sha: meta.split(' ')[2] ?? '', p };
      });
    const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], { env });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stdin.end(items.map((i) => i.sha).join('\n') + '\n');
    await new Promise<void>((resolve, reject) =>
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`git cat-file exited ${code}`)),
      ),
    );
    const buf = Buffer.concat(chunks);
    // Check every blob (and the commit) before deleting the old folder, so a missing blob leaves
    // the previous extract intact instead of a partial tree.
    const files: { file: string; data: Buffer }[] = [];
    let pos = 0;
    for (const it of items) {
      const nl = buf.indexOf(10, pos);
      const [sha, type, size] = buf.subarray(pos, nl).toString().split(' ');
      if (sha !== it.sha || type !== 'blob') {
        throw new Error(
          `${tag}: blob ${it.sha} (${it.p}) is not available locally; fetch it first`,
        );
      }
      const n = Number(size);
      const file = path.join(dest, it.p.replace(/^resources\/profiles\//, 'system/'));
      if (!file.startsWith(dest + path.sep)) throw new Error(`${tag}: odd path ${it.p}`);
      files.push({ file, data: buf.subarray(nl + 1, nl + 1 + n) });
      pos = nl + 1 + n + 1;
    }
    const commit = execFileSync('git', ['-C', repo, 'rev-parse', `${tag}^{commit}`], { env })
      .toString()
      .trim();
    rmSync(dest, { recursive: true, force: true });
    for (const { file, data } of files) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, data);
    }
    writeFileSync(path.join(dest, 'COMMIT'), `${commit}\n`);
    console.log(`${folder} ${commit} ${items.length} files`);
  }
}

// ---------------------------------------------------------------------------------------------
// run

interface Release {
  tag: string;
  commit: string | null;
  files: Record<string, string>;
  index: SystemIndex;
  /**
   * Parsed body of each preset, by the name Studio knows it by: the "name" inside its file, not
   * the BBL.json entry (PresetBundle.cpp:6631@v02.09.01.70). They differ in a few old profiles.
   */
  bodies: Map<string, Record<string, unknown>>;
  /** Studio name -> index name (what SystemIndex methods take). The first file wins, as in Studio. */
  keyOf: Map<string, string>;
}

async function loadRelease(dir: string, tag: string): Promise<Release> {
  const root = path.join(dir, tag);
  const files = readSystemCopy(root);
  const index = await loadSystemIndexes(memFs(files));
  const byLower = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  const bodies = new Map<string, Record<string, unknown>>();
  const keyOf = new Map<string, string>();
  for (const [key, e] of index.entries) {
    const raw = byLower.get(e.path.toLowerCase());
    if (raw === undefined) continue;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(stripBom(raw)) as Record<string, unknown>;
    } catch {
      continue; // unreadable: treated as absent
    }
    const own = body['name'];
    const name = typeof own === 'string' && own !== '' ? own : key;
    if (keyOf.has(name)) continue;
    keyOf.set(name, key);
    bodies.set(name, body);
  }
  const commitFile = path.join(root, 'COMMIT');
  const commit = existsSync(commitFile) ? readFileSync(commitFile, 'utf8').trim() : null;
  return { tag, commit, files, index, bodies, keyOf };
}

/** A string field as Studio resolves it: from the nearest preset in the inherits chain. */
function effective(rel: Release, name: string, key: string): string | undefined {
  const seen = new Set<string>();
  for (let n: string | undefined = name; n && !seen.has(n);) {
    seen.add(n);
    const b = rel.bodies.get(n);
    if (!b) return undefined;
    const v = b[key];
    if (typeof v === 'string' && v !== '') return v;
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0] !== '') return v[0];
    n = typeof b['inherits'] === 'string' ? b['inherits'] : undefined;
  }
  return undefined;
}

function instantiable(rel: Release, name: string): boolean {
  const v = rel.bodies.get(name)?.['instantiation'];
  return v === 'true' || v === true;
}

type Truth =
  'setting_id' | 'single' | 'multi' | 'split' | 'partial' | 'sid-moved' | 'none' | 'no-compat';
const TRUTHS: readonly Truth[] = [
  'setting_id',
  'single',
  'multi',
  'split',
  'partial',
  'sid-moved',
  'none',
  'no-compat',
];

/**
 * How the synthetic user preset carries compatible_printers: not at all, R's whole effective
 * list, or one entry of it at a time (one run per entry; what Studio writes when the user saved
 * the preset with one printer and nozzle selected).
 */
type CompatMode = 'none' | 'full' | 'one';
const MODES: readonly CompatMode[] = ['none', 'full', 'one'];

interface Case {
  removed: string;
  filamentId?: string;
  settingId?: string;
  required: string[];
  truth: Truth;
  /** The true successor, when there is one. */
  successor?: string;
  /** Every acceptable fix (same filament_id, covers every required entry). */
  acceptable: string[];
  /** Per required entry: the same-filament presets that cover it (for compat mode "one"). */
  acceptableFor: Record<string, string[]>;
  /** Same-filament presets covering some required entries. */
  partialFits: string[];
  /** A new preset with R's setting_id, whatever it covers. */
  settingIdMatch?: string;
  runs: RunResult[];
}

interface RunResult {
  mode: CompatMode;
  baseId: boolean;
  /** Compat mode "one": the entry the user preset listed. */
  entry?: string;
  /** Some acceptable fix exists for this run. */
  fixable: boolean;
  preselected: string | null;
  outcome: 'correct' | 'WRONG' | 'none';
  /** Confidence of the best-placed acceptable candidate, or null when none is a candidate. */
  fixConfidence: string | null;
  candidates: number;
}

const covers = (have: readonly string[], need: readonly string[]): boolean =>
  need.every((n) => have.includes(n));

async function buildCases(oldR: Release, newR: Release): Promise<Case[]> {
  const removed = [...oldR.keyOf.keys()].filter((n) => instantiable(oldR, n) && !newR.keyOf.has(n));
  const newInst = [...newR.keyOf.keys()].filter((n) => instantiable(newR, n));
  const newByFid = new Map<string, string[]>();
  const newBySid = new Map<string, string>();
  for (const n of newInst) {
    const fid = effective(newR, n, 'filament_id');
    if (fid) newByFid.set(fid, [...(newByFid.get(fid) ?? []), n]);
    const sid = newR.bodies.get(n)?.['setting_id'];
    if (typeof sid === 'string' && sid !== '') newBySid.set(sid, n);
  }
  const compatOf = new Map<string, string[]>();
  for (const n of newInst) {
    compatOf.set(n, (await newR.index.effectiveCompatiblePrinters(newR.keyOf.get(n)!)) ?? []);
  }

  const cases: Case[] = [];
  for (const r of removed) {
    const fid = effective(oldR, r, 'filament_id');
    const sidRaw = oldR.bodies.get(r)?.['setting_id'];
    const sid = typeof sidRaw === 'string' && sidRaw !== '' ? sidRaw : undefined;
    const required = (await oldR.index.effectiveCompatiblePrinters(oldR.keyOf.get(r)!)) ?? [];
    const sameFid = fid ? (newByFid.get(fid) ?? []) : [];
    const acceptable =
      required.length > 0 ? sameFid.filter((n) => covers(compatOf.get(n)!, required)) : [];
    const acceptableFor: Record<string, string[]> = {};
    for (const q of required)
      acceptableFor[q] = sameFid.filter((n) => compatOf.get(n)!.includes(q));
    const partialFits = sameFid.filter((n) => required.some((q) => compatOf.get(n)!.includes(q)));
    const sidMatch = sid ? newBySid.get(sid) : undefined;
    const c: Case = {
      removed: r,
      required,
      truth: 'none',
      acceptable,
      acceptableFor,
      partialFits,
      runs: [],
    };
    if (fid) c.filamentId = fid;
    if (sid) c.settingId = sid;
    if (sidMatch) c.settingIdMatch = sidMatch;

    if (required.length === 0) c.truth = 'no-compat';
    else if (sidMatch && acceptable.includes(sidMatch)) {
      c.truth = 'setting_id';
      c.successor = sidMatch;
    } else if (acceptable.length === 1) {
      c.truth = 'single';
      c.successor = acceptable[0]!;
    } else if (acceptable.length > 1) c.truth = 'multi';
    else if (partialFits.length > 0) {
      const union = new Set(partialFits.flatMap((n) => compatOf.get(n)!));
      c.truth = required.every((q) => union.has(q)) ? 'split' : 'partial';
    } else c.truth = sidMatch ? 'sid-moved' : 'none';
    cases.push(c);
  }
  return cases;
}

function safeFileStem(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

interface Job {
  c: Case;
  compat: string[] | null;
  entry?: string;
  acceptable: string[];
}

/** One scan over the new release with one synthetic user preset per job. */
async function scanJobs(
  newR: Release,
  jobs: Job[],
  mode: CompatMode,
  baseId: boolean,
): Promise<void> {
  if (jobs.length === 0) return;
  const files: Record<string, string> = { ...newR.files };
  const byName = new Map<string, Job>();
  for (const job of jobs) {
    const name = `Test of ${job.c.removed}`;
    const json: Record<string, unknown> = {
      filament_settings_id: [name],
      from: 'User',
      inherits: job.c.removed,
      name,
    };
    if (job.compat) json['compatible_printers'] = job.compat;
    const base = `user/${ACCOUNT}/filament/${safeFileStem(name)}`;
    files[`${base}.json`] = JSON.stringify(json, null, 4);
    if (baseId) {
      files[`${base}.info`] =
        `sync_info = \r\nuser_id = ${ACCOUNT}\r\nsetting_id = PFUS0000000000000a\r\n` +
        `base_id = ${job.c.settingId}\r\nupdated_time = 1782278409\r\n`;
    }
    byName.set(name, job);
  }
  const result = await scan(memFs(files), { userId: ACCOUNT });
  const record = (job: Job, cands: Candidate[]): void => {
    const pick = cands.find((x) => x.preselected)?.name ?? null;
    const ok = new Set(job.acceptable);
    const best = cands.find((x) => ok.has(x.name));
    const r: RunResult = {
      mode,
      baseId,
      fixable: ok.size > 0,
      preselected: pick,
      outcome: pick === null ? 'none' : ok.has(pick) ? 'correct' : 'WRONG',
      fixConfidence: best ? best.confidence : null,
      candidates: cands.length,
    };
    if (job.entry !== undefined) r.entry = job.entry;
    job.c.runs.push(r);
  };
  for (const f of result.findings) {
    if (f.ruleId !== RULE_IDS.orphanedParent) continue;
    const job = f.presetName ? byName.get(f.presetName) : undefined;
    if (!job) continue;
    byName.delete(f.presetName!);
    record(job, f.proposedFix?.kind === 'setInherits' ? f.proposedFix.candidates : []);
  }
  for (const job of byName.values()) record(job, []);
}

async function runCases(newR: Release, cases: Case[]): Promise<void> {
  for (const baseId of [false, true]) {
    const eligible = cases.filter((c) => !baseId || c.settingId !== undefined);
    await scanJobs(
      newR,
      eligible.map((c) => ({ c, compat: null, acceptable: c.acceptable })),
      'none',
      baseId,
    );
    await scanJobs(
      newR,
      eligible.map((c) => ({ c, compat: c.required, acceptable: c.acceptable })),
      'full',
      baseId,
    );
    // One scan per entry index: a user folder holds only one preset per name.
    const most = Math.max(0, ...eligible.map((c) => c.required.length));
    for (let k = 0; k < most; k++) {
      const jobs: Job[] = [];
      for (const c of eligible) {
        const entry = c.required[k];
        if (entry === undefined) continue;
        jobs.push({ c, compat: [entry], entry, acceptable: c.acceptableFor[entry] ?? [] });
      }
      await scanJobs(newR, jobs, 'one', baseId);
    }
  }
}

/** How the true successor's name differs from the removed one. */
function renamePattern(from: string, to: string): string {
  const a = parsePresetName(from);
  const b = parsePresetName(to);
  if (!a || !b) return 'unparsed';
  const parts: string[] = [];
  if (a.stem !== b.stem) {
    if (a.stem.toLowerCase() === b.stem.toLowerCase()) parts.push('stem case');
    else parts.push(`stem "${a.stem}" -> "${b.stem}"`);
  }
  const pa = `${a.vendorTag ?? ''} ${a.printerCode ?? ''}`.trim();
  const pb = `${b.vendorTag ?? ''} ${b.printerCode ?? ''}`.trim();
  if (pa !== pb) parts.push(`printer code ${pa || '-'} -> ${pb || '-'}`);
  if ((a.nozzle ?? '') !== (b.nozzle ?? '')) {
    parts.push(`nozzle suffix ${a.nozzle ?? 'none'} -> ${b.nozzle ?? 'none'}`);
  }
  return parts.join('; ') || 'same';
}

interface Tally {
  runs: number;
  fixable: number;
  correct: number;
  wrong: number;
  none: number;
  /** Fixable runs where an acceptable fix is among the candidates. */
  fixListed: number;
  /** ... at high confidence. */
  fixHigh: number;
}
const emptyTally = (): Tally => ({
  runs: 0,
  fixable: 0,
  correct: 0,
  wrong: 0,
  none: 0,
  fixListed: 0,
  fixHigh: 0,
});
const vkey = (mode: CompatMode, baseId: boolean): string =>
  `compat=${mode}${baseId ? '+base_id' : ''}`;
const VARIANT_KEYS = MODES.flatMap((m) => [vkey(m, false), vkey(m, true)]);

function tally(cases: Case[]): Record<string, Tally> {
  const out: Record<string, Tally> = {};
  for (const k of VARIANT_KEYS) out[k] = emptyTally();
  for (const c of cases) {
    for (const r of c.runs) {
      const t = out[vkey(r.mode, r.baseId)]!;
      t.runs++;
      if (r.fixable) t.fixable++;
      if (r.outcome === 'correct') t.correct++;
      else if (r.outcome === 'WRONG') t.wrong++;
      else t.none++;
      if (r.fixable && r.fixConfidence) t.fixListed++;
      if (r.fixable && r.fixConfidence === 'high') t.fixHigh++;
    }
  }
  return out;
}

interface Pair {
  old: string;
  new: string;
  oldCommit: string | null;
  newCommit: string | null;
  oldVersion: string | null;
  newVersion: string | null;
  /** The profile version went down: a merge artifact, never shipped as an update. */
  backwards: boolean;
  truth: Record<Truth, number>;
  tally: Record<string, Tally>;
  cases: Case[];
}

const fmtTally = (t: Tally): string =>
  `${t.correct}/${t.wrong}/${t.none} fix listed ${t.fixListed}/${t.fixable} (high ${t.fixHigh})`;

async function run(
  dir: string,
  pairList: [string, string][],
  jsonOut: string | null,
  list: boolean,
): Promise<void> {
  const pairs: Pair[] = [];
  const cache = new Map<string, Release>();
  const release = async (tag: string): Promise<Release> => {
    let r = cache.get(tag);
    if (!r) {
      r = await loadRelease(dir, tag);
      cache.set(tag, r);
    }
    return r;
  };
  for (const [oldTag, newTag] of pairList) {
    const oldR = await release(oldTag);
    const newR = await release(newTag);
    // Only the newer release can be reused by the next pair.
    for (const k of [...cache.keys()]) if (k !== newTag) cache.delete(k);
    const cases = await buildCases(oldR, newR);
    await runCases(newR, cases);
    const truth = Object.fromEntries(TRUTHS.map((t) => [t, 0])) as Record<Truth, number>;
    for (const c of cases) truth[c.truth]++;
    pairs.push({
      old: oldTag,
      new: newTag,
      oldCommit: oldR.commit,
      newCommit: newR.commit,
      oldVersion: oldR.index.version,
      newVersion: newR.index.version,
      backwards: (newR.index.version ?? '') < (oldR.index.version ?? ''),
      truth,
      tally: tally(cases),
      cases,
    });
  }

  console.log(
    'Per pair: removed, truth, then per variant correct/WRONG/no-preselection and how often an ' +
      'acceptable fix is listed.\n',
  );
  for (const p of pairs) {
    const t = p.truth;
    const truthCells = TRUTHS.filter((k) => t[k] > 0).map((k) => `${k} ${t[k]}`);
    console.log(
      `${p.old} (${p.oldVersion}) -> ${p.new} (${p.newVersion})${p.backwards ? ' [version went backwards]' : ''}: ` +
        `removed ${p.cases.length}${truthCells.length ? ` (${truthCells.join(', ')})` : ''}`,
    );
    if (p.cases.length === 0) continue;
    for (const k of VARIANT_KEYS) console.log(`    ${k.padEnd(22)} ${fmtTally(p.tally[k]!)}`);
  }

  const all = pairs.flatMap((p) => p.cases);
  const truthTot = Object.fromEntries(TRUTHS.map((t) => [t, 0])) as Record<Truth, number>;
  for (const c of all) truthTot[c.truth]++;
  const tot = tally(all);
  console.log(
    `\nTotal: ${pairs.length} pairs, ${all.length} removed presets; truth ` +
      TRUTHS.filter((k) => truthTot[k] > 0)
        .map((k) => `${k} ${truthTot[k]}`)
        .join(', '),
  );
  for (const k of VARIANT_KEYS) console.log(`    ${k.padEnd(22)} ${fmtTally(tot[k]!)}`);
  const withSid = all.filter((c) => c.settingId).length;
  const sidMoved = all.filter((c) => c.settingIdMatch).length;
  console.log(`  setting_id carried over to another name: ${sidMoved}/${withSid}`);

  if (list) {
    console.log('\nWRONG pre-selections:');
    for (const p of pairs) {
      for (const c of p.cases) {
        for (const r of c.runs) {
          if (r.outcome !== 'WRONG') continue;
          const ok = r.entry !== undefined ? (c.acceptableFor[r.entry] ?? []) : c.acceptable;
          console.log(
            `  ${p.old} -> ${p.new} ${vkey(r.mode, r.baseId)}${r.entry ? ` [${r.entry}]` : ''}: ` +
              `"${c.removed}" (${c.truth}) -> "${r.preselected}"; right: ${ok.map((a) => `"${a}"`).join(', ') || 'none'}`,
          );
        }
      }
    }
    console.log('\nAn acceptable fix exists but is not a candidate (compat=none, no base_id):');
    const patterns = new Map<string, number>();
    for (const p of pairs) {
      for (const c of p.cases) {
        const r = c.runs.find((x) => x.mode === 'none' && !x.baseId);
        if (!r?.fixable || r.fixConfidence) continue;
        const to = c.successor ?? c.acceptable[0]!;
        const pat = renamePattern(c.removed, to);
        patterns.set(pat, (patterns.get(pat) ?? 0) + 1);
        console.log(`  ${p.old} -> ${p.new}: "${c.removed}" -> "${to}" (${c.truth}): ${pat}`);
      }
    }
    console.log('\nThose by rename pattern:');
    for (const [pat, n] of [...patterns].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${pat}`);
    }
    console.log('\nsetting_id carried over to another name:');
    for (const p of pairs) {
      for (const c of p.cases) {
        if (!c.settingIdMatch) continue;
        console.log(
          `  ${p.old} -> ${p.new}: "${c.removed}" (${c.settingId}) -> "${c.settingIdMatch}" (${c.truth}): ` +
            renamePattern(c.removed, c.settingIdMatch),
        );
      }
    }
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(pairs, null, 1));
}

// ---------------------------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'extract' && rest.length >= 3) {
  const [repo, out, ...tags] = rest as [string, string, ...string[]];
  await extract(refuseAppData(repo), refuseAppData(out), tags);
} else if (cmd === 'run' && rest.length >= 1) {
  const dir = refuseAppData(rest[0]!);
  const opt = (flag: string): string | null => {
    const i = rest.indexOf(flag);
    return i >= 0 ? (rest[i + 1] ?? null) : null;
  };
  // --pairs old:new,... runs exactly those pairs; otherwise consecutive --tags (in the order
  // given) or every release folder, sorted by name.
  const pairsOpt = opt('--pairs');
  let pairList: [string, string][];
  if (pairsOpt) {
    pairList = pairsOpt.split(',').map((p) => p.split(':') as [string, string]);
  } else {
    const tags =
      opt('--tags')?.split(',') ??
      readdirSync(dir)
        .filter((t) => existsSync(path.join(dir, t, 'system', 'BBL.json')))
        .sort();
    pairList = tags.slice(1).map((t, i) => [tags[i]!, t]);
  }
  const json = opt('--json');
  await run(dir, pairList, json ? refuseAppData(json) : null, rest.includes('--list'));
} else {
  console.error(
    'Usage:\n' +
      '  node scripts/r1-history.ts extract <BambuStudio clone> <history dir> <tag | folder=rev>...\n' +
      '  node scripts/r1-history.ts run <history dir> [--tags a,b,c | --pairs a:b,c:d] ' +
      '[--json <file>] [--list]',
  );
  process.exit(2);
}
