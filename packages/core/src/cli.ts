#!/usr/bin/env node
/**
 * preset-doctor command line. `main(argv, deps)` does all the work and returns the exit code,
 * so tests can run it with fake output, paths and process checks.
 */
import { realpathSync } from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertBackupCovers,
  BackupCoverageError,
  BackupSlicerError,
  BackupSourceError,
  createBackup,
  listBackups,
  restoreBackup,
  RestoreError,
} from './backup.js';
import {
  applyChanges,
  ApplyError,
  defaultChoices,
  findStale,
  FixError,
  planFixes,
  StaleChangeError,
} from './fix.js';
import { unifiedDiff } from './diff.js';
import { errorMessage } from './fs.js';
import { VERSION } from './index.js';
import { defaultPaths, isSlicerRunning, type DefaultPaths } from './node/studioProcess.js';
import { nodeFs } from './node/nodeFs.js';
import { FAMILY_NOTE_ID, R3_NOTE_ID } from './rules/r2r3.js';
import { R5_ID, scan, ScanError } from './scan.js';
import {
  BAMBU,
  detectSlicer,
  ORCA,
  SLICERS,
  slicerById,
  slicerFolder,
  type SlicerProfile,
} from './slicer.js';
import { TERMS } from './terms.js';
import {
  PRESET_TYPES,
  type Finding,
  type PresetStatus,
  type PresetSummary,
  type PresetType,
  type ScanResult,
  type SlicerId,
} from './types.js';

export const EXIT = {
  /** Finished; for `scan`, no hidden or broken presets. */
  ok: 0,
  /** `scan` found hidden or broken presets. */
  problems: 1,
  /** Bad command line. */
  usage: 2,
  /** Could not read or write something (wrong folder, unknown account, failed write). */
  failed: 3,
  /** Refused for safety: the slicer is running, or files changed since they were checked. */
  refused: 4,
} as const;

export interface CliDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  paths: DefaultPaths;
  /** Whether the slicer whose folder is written is running (Bambu Studio when not given). */
  isStudioRunning: (slicer?: SlicerProfile) => Promise<boolean>;
  now: () => Date;
}

const HELP = `Preset Doctor ${VERSION} for Bambu Studio and OrcaSlicer: finds and repairs presets
(filament, process and printer) that disappeared after a slicer update. Works offline; nothing
leaves your computer. Not affiliated with Bambu Lab or the OrcaSlicer project.

Usage:
  preset-doctor scan [folder] [--slicer <name>] [--user <id>] [--type <types>] [--json]
      List every preset and whether the slicer can show it.
  preset-doctor fix [folder] [--slicer <name>] [--user <id>] [--type <types>] [--dry-run]
      Show the repairs Preset Doctor is confident about, as diffs. Writes nothing.
  preset-doctor fix [folder] [...] --apply --yes [--no-base-id]
      Back up the user folder, then make those repairs. Close the slicer first.
  preset-doctor backups [list]
      List backups made before repairs.
  preset-doctor backups restore <id> [folder] [--slicer <name>] --yes [--from-other-folder]
      Put a backup back (the current state is backed up first). A backup made from another
      folder is refused unless --from-other-folder is given; one made from the other slicer's
      folder is always refused.

Options:
  folder           The slicer's data folder. Default: %APPDATA%\\BambuStudio, or with
                   --slicer orca, %APPDATA%\\OrcaSlicer. The slicer is read from the folder.
  --slicer <name>  bambu or orca: which default folder to use. With a folder, it must be that
                   slicer's folder.
  --user <id>      Account folder under user\\ to check. Default: the one with most presets.
  --type <types>   Only these preset types: filament, process, printer (or machine), comma-
                   separated or repeated. Default: all. --json always prints everything.
  --json           Print the scan result as JSON.
  --no-base-id     Don't update base_id in the .info sync files when changing a parent.
  --backups <dir>  Backup folder. Default: %APPDATA%\\PresetDoctor\\backups
  -h, --help       Show this help.   --version   Show the version.

Exit codes:
  0  done (scan: nothing hidden or broken)
  1  scan found hidden or broken presets
  2  bad command line
  3  something could not be read or written (scan: the system presets could not be read,
     so parent presets were not checked)
  4  refused for safety (the slicer is running, files changed meanwhile, or a backup
     came from another folder or the other slicer)
`;

interface Args {
  positional: string[];
  user?: string;
  /** --type, in the order given; undefined means every type. */
  types?: PresetType[];
  /** --slicer. */
  slicer?: SlicerId;
  backups?: string;
  json: boolean;
  dryRun: boolean;
  apply: boolean;
  yes: boolean;
  noBaseId: boolean;
  fromOtherFolder: boolean;
  help: boolean;
  version: boolean;
}

class UsageError extends Error {}

/** The Args keys that a bare flag switches on. */
type BoolFlag = { [K in keyof Args]: Args[K] extends boolean ? K : never }[keyof Args];

/** A Map, not an object: `'constructor' in {}` is true, which would swallow a folder so named. */
const FLAGS: ReadonlyMap<string, BoolFlag> = new Map<string, BoolFlag>([
  ['--json', 'json'],
  ['--dry-run', 'dryRun'],
  ['--apply', 'apply'],
  ['--yes', 'yes'],
  ['-y', 'yes'],
  ['--no-base-id', 'noBaseId'],
  ['--from-other-folder', 'fromOtherFolder'],
  ['--help', 'help'],
  ['-h', 'help'],
  ['--version', 'version'],
]);

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    positional: [],
    json: false,
    dryRun: false,
    apply: false,
    yes: false,
    noBaseId: false,
    fromOtherFolder: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? a.split(/=(.*)/s) : [a];
    const key = flag === undefined ? undefined : FLAGS.get(flag);
    if (flag === '--user' || flag === '--backups' || flag === '--type' || flag === '--slicer') {
      const value = inline ?? argv[++i];
      if (value === undefined || value === '') throw new UsageError(`${flag} needs a value.`);
      if (flag === '--user') args.user = value;
      else if (flag === '--type') args.types = addTypes(args.types ?? [], value);
      else if (flag === '--slicer') args.slicer = slicerArg(value);
      else args.backups = value;
    } else if (key !== undefined) {
      args[key] = true;
    } else if (a.startsWith('-') && a !== '-') {
      throw new UsageError(`Unknown option ${a}.`);
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

/** "orca" / "OrcaSlicer" -> 'orca'; "bambu" / "BambuStudio" / "studio" -> 'bambu'. */
function slicerArg(value: string): SlicerId {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  if (v === 'orca' || v === 'orcaslicer') return 'orca';
  if (v === 'bambu' || v === 'bambustudio' || v === 'studio') return 'bambu';
  throw new UsageError(`Unknown slicer "${value}" for --slicer. Use bambu or orca.`);
}

/** "process,printer" -> ['process', 'machine'], added to `types` without repeats. */
function addTypes(types: PresetType[], value: string): PresetType[] {
  const out = [...types];
  for (const raw of value.split(',')) {
    const word = raw.trim().toLowerCase();
    const type = word === 'printer' ? 'machine' : PRESET_TYPES.find((t) => t === word);
    if (type === undefined) {
      throw new UsageError(
        `Unknown preset type "${raw.trim()}" for --type. Use filament, process or printer.`,
      );
    }
    if (!out.includes(type)) out.push(type);
  }
  return out;
}

/** True when --type selects this preset's type (every type without --type). */
function selected(args: Args, p: { type?: PresetType }): boolean {
  return args.types === undefined || args.types.includes(p.type ?? 'filament');
}

export async function main(argv: readonly string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const d: CliDeps = {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    paths: deps.paths ?? defaultPaths(),
    isStudioRunning: (slicer) => isSlicerRunning(slicer ?? BAMBU),
    now: () => new Date(),
    ...deps,
  };
  const out = (line = ''): void => d.stdout(line + '\n');
  const err = (line: string): void => d.stderr(line + '\n');

  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`${errorMessage(e)} Run "preset-doctor --help" for usage.`);
    return EXIT.usage;
  }
  if (args.version) {
    out(VERSION);
    return EXIT.ok;
  }
  const [command, ...rest] = args.positional;
  if (args.help || command === undefined || command === 'help') {
    out(HELP);
    return EXIT.ok;
  }

  try {
    switch (command) {
      case 'scan':
        return await scanCommand(args, rest, d, out);
      case 'fix':
        return await fixCommand(args, rest, d, out, err);
      case 'backups':
        return await backupsCommand(args, rest, d, out, err);
      default:
        err(`Unknown command "${command}". Run "preset-doctor --help" for usage.`);
        return EXIT.usage;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message} Run "preset-doctor --help" for usage.`);
      return EXIT.usage;
    }
    if (e instanceof StaleChangeError || (e instanceof FixError && e.stale)) {
      err(e.message);
      return EXIT.refused;
    }
    err(e instanceof ScanError || e instanceof FixError ? e.message : `Error: ${errorMessage(e)}`);
    return EXIT.failed;
  }
}

function rootArg(rest: string[], d: CliDeps, args: Args): string {
  if (rest.length > 1) throw new UsageError(`Too many arguments: ${rest.join(' ')}.`);
  return rest[0] ?? (args.slicer === 'orca' ? d.paths.orcaRoot : d.paths.studioRoot);
}

/**
 * The slicer of the folder, read from its files. With --slicer, a folder of the other slicer is a
 * usage error. A folder that can't be told apart counts as --slicer's, or Bambu Studio's, with
 * `detected` false: a write then checks that no slicer at all is running.
 */
async function folderSlicer(
  root: string,
  args: Args,
): Promise<{ profile: SlicerProfile; detected: boolean }> {
  const detected = await detectSlicer(nodeFs(root, { readOnly: true }));
  if (detected.ok && args.slicer !== undefined && detected.profile.id !== args.slicer) {
    throw new UsageError(
      `${root} is ${slicerFolder(detected.profile.id)}, not ${slicerFolder(args.slicer)} ` +
        `(${detected.evidence})`,
    );
  }
  if (detected.ok) return { profile: detected.profile, detected: true };
  return { profile: slicerById(args.slicer ?? 'bambu'), detected: false };
}

async function runScan(root: string, args: Args): Promise<ScanResult> {
  const fs = nodeFs(root, { readOnly: true });
  if (!(await fs.exists(''))) throw new ScanError(`The folder ${root} does not exist.`);
  await folderSlicer(root, args);
  return scan(fs, args.user !== undefined ? { userId: args.user, root } : { root });
}

async function scanCommand(
  args: Args,
  rest: string[],
  d: CliDeps,
  out: (l?: string) => void,
): Promise<number> {
  const result = await runScan(rootArg(rest, d, args), args);
  if (args.json) out(JSON.stringify(result, null, 2));
  else printScan(result, args, out);
  const rows = result.presets.filter((p) => selected(args, p));
  // Without a type's system index no parent of that type was checked: a clean exit would claim
  // nothing is hidden.
  if (rows.some((p) => p.inherits && !indexRead(result, p))) {
    if (!args.json) {
      out();
      out(
        slicerById(result.slicer).reword(
          'INCOMPLETE: the system presets could not be read, so Preset Doctor could not check ' +
            'whether the parent presets still exist. Open Bambu Studio once, close it, and scan again.',
        ),
      );
    }
    return EXIT.failed;
  }
  const bad = rows.some((p) => p.status === 'hidden' || p.status === 'broken');
  return bad ? EXIT.problems : EXIT.ok;
}

/** Whether the system index of the preset's type could be read. */
function indexRead(r: ScanResult, p: PresetSummary): boolean {
  return r.indexesRead[p.type ?? 'filament'];
}

const GROUPS: { status: PresetStatus; label: string }[] = [
  { status: 'hidden', label: 'Hidden in Studio' },
  { status: 'broken', label: 'Broken' },
  // Printed only when the printer checks ran, so output without them stays as it was.
  { status: 'unsupported', label: 'Loaded, but not offered for your printers' },
  { status: 'info', label: 'OK, with notes' },
  { status: 'ok', label: 'OK' },
];

function printScan(r: ScanResult, args: Args, out: (l?: string) => void): void {
  printHeader(r, args, out);
  const profile = slicerById(r.slicer);
  const byPath = new Map<string, Finding[]>();
  for (const f of r.findings) {
    const list = byPath.get(f.presetPath);
    if (list) list.push(f);
    else byPath.set(f.presetPath, [f]);
  }

  const shown = r.presets.filter((p) => selected(args, p));
  // With more than one type, each group lists its rows per type, under a sub-heading.
  const types = PRESET_TYPES.filter((t) => shown.some((p) => p.type === t));
  const nested = types.length > 1;
  const indent = nested ? '    ' : '  ';
  for (const g of GROUPS) {
    if (g.status === 'unsupported' && !r.compat.checked) continue;
    const rows = shown.filter((p) => p.status === g.status);
    out();
    out(`${profile.reword(g.label)} (${rows.length})`);
    if (rows.length === 0) continue;
    const width = Math.min(48, Math.max(...rows.map((p) => label(p).length)));
    for (const type of nested ? types : [undefined]) {
      const part = type === undefined ? rows : rows.filter((p) => p.type === type);
      if (part.length === 0) continue;
      if (type !== undefined) out(`  ${TERMS[type].tab}:`);
      for (const p of part) {
        out(`${indent}${label(p).padEnd(width)}  ${p.reason}`);
        if (g.status === 'ok') continue;
        for (const f of byPath.get(p.path) ?? []) {
          const note = fixNote(f);
          if (note) out(`${indent}${''.padEnd(width)}  ${note}`);
        }
      }
    }
  }

  const count = (s: PresetStatus): number => shown.filter((p) => p.status === s).length;
  out();
  const unsupported = count('unsupported');
  out(
    `Summary: ${count('hidden')} hidden, ${count('broken')} broken, ` +
      (unsupported > 0 ? `${unsupported} unsupported, ` : '') +
      `${count('info')} OK with notes, ${count('ok')} OK.`,
  );
  const paths = new Set(shown.map((p) => p.path));
  if (r.findings.some((f) => f.proposedFix && paths.has(f.presetPath))) {
    out(`To preview repairs: ${fixHint(r.root, args, r, '--dry-run')}`);
  }
}

function printHeader(r: ScanResult, args: Args, out: (l?: string) => void): void {
  out(`Preset Doctor ${VERSION}`);
  out(`Folder:  ${r.root}`);
  // Bambu Studio output stays as it was before OrcaSlicer was supported.
  if (r.slicer === 'orca')
    out(`Slicer:  ${ORCA.displayName} ${r.slicerVersion ?? '(version unknown)'}`);
  out(`System presets: ${r.systemVersion ? `version ${r.systemVersion}` : 'could not be read'}`);
  const me = r.accounts.find((a) => a.id === r.userId);
  const others = r.accounts.filter((a) => a.id !== r.userId);
  out(
    `Account: ${r.userId || '(none)'}${me ? ` (${me.presetCount} presets)` : ''}` +
      (others.length
        ? `; others: ${others.map((a) => `${a.id} (${a.presetCount})`).join(', ')}`
        : ''),
  );
  if (r.compat.checked) out(`Printers: ${printersLine(r)}`);
  // The R3 note is about filament and process presets only, the copies note about filaments.
  const r3Shown = selected(args, { type: 'filament' }) || selected(args, { type: 'process' });
  const copiesShown = selected(args, { type: 'filament' });
  for (const f of r.findings.filter(
    (x) =>
      x.ruleId === R5_ID ||
      (x.ruleId === R3_NOTE_ID && r3Shown) ||
      (x.ruleId === FAMILY_NOTE_ID && copiesShown),
  )) {
    out();
    out(`Note: ${f.title}. ${f.explanation}`);
  }
  for (const w of r.warnings) out(`Note: ${w}`);
}

/** "Bambu Lab X2D (0.4, 0.6 mm), Bambu Lab P1S (0.4 mm); selected: Bambu Lab X2D 0.4 nozzle" */
function printersLine(r: ScanResult): string {
  const c = r.compat;
  const parts = c.enabled.map((m) => `${m.model} (${m.nozzles.join(', ')} mm)`);
  if (c.userPrinters > 0) {
    parts.push(`${c.userPrinters} printer preset${c.userPrinters === 1 ? '' : 's'} of your own`);
  }
  const added = parts.length > 0 ? parts.join(', ') : 'none added';
  return added + (c.selectedPrinter !== undefined ? `; selected: ${c.selectedPrinter}` : '');
}

function label(p: PresetSummary): string {
  return (p.name ?? p.fileStem) + (p.isBase ? ' [base]' : '');
}

function fixNote(f: Finding): string | undefined {
  const fix = f.proposedFix;
  if (fix?.kind === 'renamePreset') return `fix: rename to "${fix.newName}"`;
  if (fix?.kind !== 'setInherits')
    return f.status === 'hidden' && f.severity === 'error' ? 'no replacement found' : undefined;
  const pick = fix.candidates.find((c) => c.preselected);
  if (pick) return `fix: switch parent to "${pick.name}" (${pick.confidence} confidence)`;
  // Printer presets are never pre-selected, however good the match: the user has the printer.
  if (f.presetType === 'machine') {
    return `${fix.candidates.length} possible replacement(s); pick the printer you have in the app`;
  }
  return `${fix.candidates.length} possible replacement(s), none certain; pick one in the app`;
}

async function fixCommand(
  args: Args,
  rest: string[],
  d: CliDeps,
  out: (l?: string) => void,
  err: (l: string) => void,
): Promise<number> {
  if (args.apply && args.dryRun) throw new UsageError('Use either --dry-run or --apply, not both.');
  const root = rootArg(rest, d, args);
  const result = await runScan(root, args);
  const profile = slicerById(result.slicer);
  const inScope = new Set(result.presets.filter((p) => selected(args, p)).map((p) => p.path));
  const choices = defaultChoices(result).filter((c) => inScope.has(c.presetPath));
  const readFs = nodeFs(root, { readOnly: true });
  const changes = await planFixes(readFs, result, choices, { updateBaseId: !args.noBaseId });

  printHeader(result, args, out);
  const unfixable = result.findings.filter(
    (f) =>
      (f.status === 'hidden' || f.status === 'broken') &&
      inScope.has(f.presetPath) &&
      !choices.some((c) => c.presetPath === f.presetPath),
  );

  out();
  if (changes.length === 0) {
    out('Nothing to repair automatically.');
  } else {
    out(`${changes.length} file change(s) planned:`);
    for (const c of changes) {
      out();
      out(`# ${c.description}`);
      out(unifiedDiff(c));
    }
  }
  if (unfixable.length > 0) {
    out();
    out('Not repaired automatically (needs a choice or a manual fix):');
    for (const f of unfixable) out(`  ${f.presetName ?? f.presetPath}: ${f.title}`);
  }

  if (!args.apply || changes.length === 0) {
    if (changes.length > 0) {
      out();
      out('Dry run: nothing was written.');
      out(
        `To make these repairs, close ${profile.displayName} and run: ${fixHint(root, args, result, '--apply --yes')}`,
      );
    }
    return EXIT.ok;
  }
  if (!args.yes) throw new UsageError('Add --yes to confirm that these files should be changed.');

  if (!(await studioClosed(d, err, [profile]))) return EXIT.refused;

  const writeFs = nodeFs(root);
  // Before the backup: a planned file that is gone since the scan is stale, not "not backed up".
  const stale = await findStale(writeFs, changes);
  if (stale.length > 0) throw new StaleChangeError(stale);
  const backupsDir = args.backups ?? d.paths.backupsDir;
  const backup = await createBackup(writeFs, nodeFs(backupsDir), {
    now: d.now(),
    reason: 'before-fix',
    sourceRoot: nodePath.resolve(root),
    slicer: profile.id,
  });
  out();
  out(`Backed up ${backup.fileCount} files to ${backupsDir} (backup ${backup.id}).`);
  try {
    assertBackupCovers(
      backup,
      changes.map((c) => c.path),
    );
  } catch (e) {
    if (!(e instanceof BackupCoverageError)) throw e;
    err(e.message);
    return EXIT.failed;
  }

  try {
    const applied = await applyChanges(writeFs, changes);
    out(`Done: changed ${applied.written.length} file(s).`);
  } catch (e) {
    if (e instanceof ApplyError) {
      err(e.message);
      err(`Already changed: ${e.written.join(', ') || 'nothing'}.`);
      err(`To undo: ${restoreHint(backup.id, root, args)}`);
      return EXIT.failed;
    }
    throw e;
  }
  out(`To undo: ${restoreHint(backup.id, root, args)}`);
  out(`Next: open ${profile.displayName} and check that the presets are back.`);
  if (result.findings.some((f) => f.ruleId === R5_ID)) {
    out(
      'Cloud preset sync is on: to upload a repair to your other computers, open the preset in ' +
        `${profile.displayName} and save it.`,
    );
  }
  return EXIT.ok;
}

/** True when none of these slicers is running; otherwise says which one is (or can't be checked). */
async function studioClosed(
  d: CliDeps,
  err: (l: string) => void,
  profiles: readonly SlicerProfile[],
): Promise<boolean> {
  for (const profile of profiles) {
    const name = profile.displayName;
    let running: boolean;
    try {
      running = await d.isStudioRunning(profile);
    } catch (e) {
      err(
        `Could not check whether ${name} is running (${errorMessage(e)}), so nothing was changed.`,
      );
      return false;
    }
    if (running) {
      err(`${name} is running. Close it and run this again; nothing was changed.`);
      return false;
    }
  }
  return true;
}

async function backupsCommand(
  args: Args,
  rest: string[],
  d: CliDeps,
  out: (l?: string) => void,
  err: (l: string) => void,
): Promise<number> {
  const [sub = 'list', ...more] = rest;
  const backupsDir = args.backups ?? d.paths.backupsDir;
  const destFs = nodeFs(backupsDir, sub === 'list' ? { readOnly: true } : {});

  if (sub === 'list') {
    if (more.length > 0) throw new UsageError(`Too many arguments: ${more.join(' ')}.`);
    const list = await listBackups(destFs);
    if (args.json) {
      out(JSON.stringify(list, null, 2));
      return EXIT.ok;
    }
    if (list.length === 0) {
      out(`No backups in ${backupsDir}.`);
      return EXIT.ok;
    }
    out(`Backups in ${backupsDir} (newest first):`);
    for (const b of list) {
      out(
        `  ${b.id.padEnd(22)}  ${String(b.fileCount).padStart(4)} files  ` +
          `${(b.reason ?? '').padEnd(14)}  from ${b.sourceRoot ?? '(unknown folder)'}` +
          (b.slicer === 'orca' ? ` (${ORCA.displayName})` : ''),
      );
    }
    return EXIT.ok;
  }

  if (sub === 'restore') {
    const [id, ...folder] = more;
    if (id === undefined)
      throw new UsageError('Which backup? Usage: preset-doctor backups restore <id>');
    const root = rootArg(folder, d, args);
    if (!args.yes)
      throw new UsageError('Add --yes to confirm that the user folder should be replaced.');
    // A folder whose slicer can't be told (both confs, or neither) may belong to either one.
    const { profile, detected } = await folderSlicer(root, args);
    if (!(await studioClosed(d, err, detected ? [profile] : SLICERS))) return EXIT.refused;
    let result;
    try {
      result = await restoreBackup(nodeFs(root), destFs, id, {
        now: d.now(),
        expectedRoot: nodePath.resolve(root),
        allowOtherSource: args.fromOtherFolder,
        slicer: profile.id,
      });
    } catch (e) {
      if (e instanceof BackupSlicerError) {
        err(e.message);
        return EXIT.refused;
      }
      if (e instanceof RestoreError) {
        err(e.message);
        if (e.safetyBackup) {
          err(
            `To go back to how it was before this restore: ${restoreHint(e.safetyBackup.id, root, args)}`,
          );
        }
        return EXIT.failed;
      }
      if (!(e instanceof BackupSourceError)) throw e;
      err(e.message);
      err(`To restore it into ${e.sourceRoot}: ${restoreHint(id, e.sourceRoot, args)}`);
      err('To put it into this folder anyway, add --from-other-folder.');
      return EXIT.refused;
    }
    out(`Restored ${result.restoredCount} files from backup ${id} into ${root}.`);
    if (result.skipped.length > 0) out(skippedNote(result.skipped.length));
    if (result.safetyBackup) {
      out(`The state before the restore was saved as backup ${result.safetyBackup.id}.`);
    }
    return EXIT.ok;
  }

  throw new UsageError(`Unknown backups command "${sub}".`);
}

/** Why some sync files were not put back (OrcaSlicer; see RestoreResult.skipped). */
export function skippedNote(n: number): string {
  return (
    `${n} sync file${n === 1 ? ' was' : 's were'} not put back because ${n === 1 ? 'its preset is' : 'their presets are'} ` +
    'gone, and restoring them alone could make OrcaSlicer delete those presets from your cloud.'
  );
}

/**
 * The `fix` command to run next, with the same account, types, base_id and backups options as
 * this run: without --user, scan would pick the account with the most presets, which may not be
 * the one just previewed.
 */
function fixHint(root: string, args: Args, result: ScanResult, mode: string): string {
  const user =
    args.user !== undefined || result.accounts.length > 1 ? ` --user ${quote(result.userId)}` : '';
  const types =
    args.types !== undefined
      ? ` --type ${args.types.map((t) => (t === 'machine' ? 'printer' : t)).join(',')}`
      : '';
  const slicer = args.slicer !== undefined ? ` --slicer ${args.slicer}` : '';
  return (
    `preset-doctor fix ${quote(root)}${slicer}${user}${types} ${mode}` +
    (args.noBaseId ? ' --no-base-id' : '') +
    backupsFlag(args)
  );
}

/** The `backups restore` command that puts backup `id` back into `root`, keeping --backups. */
function restoreHint(id: string, root: string, args: Args): string {
  return `preset-doctor backups restore ${id} ${quote(root)}${backupsFlag(args)} --yes`;
}

function backupsFlag(args: Args): string {
  return args.backups !== undefined ? ` --backups ${quote(args.backups)}` : '';
}

function quote(path: string): string {
  return /[\s"]/.test(path) ? `"${path}"` : path;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`Error: ${errorMessage(e)}\n`);
      process.exitCode = EXIT.failed;
    },
  );
}
