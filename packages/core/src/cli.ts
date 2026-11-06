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
  FixError,
  planFixes,
  StaleChangeError,
  unifiedDiff,
} from './fix.js';
import { fileStem } from './fs.js';
import { VERSION } from './index.js';
import { defaultPaths, isStudioRunning, type DefaultPaths } from './node/studioProcess.js';
import { nodeFs } from './node/nodeFs.js';
import { R5_ID, scan, ScanError } from './scan.js';
import type { Finding, PresetStatus, PresetSummary, ScanResult } from './types.js';

export const EXIT = {
  /** Finished; for `scan`, no hidden or broken presets. */
  ok: 0,
  /** `scan` found hidden or broken presets. */
  problems: 1,
  /** Bad command line. */
  usage: 2,
  /** Could not read or write something (wrong folder, unknown account, failed write). */
  failed: 3,
  /** Refused for safety: Studio is running, or files changed since they were checked. */
  refused: 4,
} as const;

export interface CliDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  paths: DefaultPaths;
  isStudioRunning: () => Promise<boolean>;
  now: () => Date;
}

const HELP = `Preset Doctor ${VERSION}: finds and repairs Bambu Studio filament presets that
disappeared after a Studio update. Works offline; nothing leaves your computer.
Not affiliated with Bambu Lab.

Usage:
  preset-doctor scan [folder] [--user <id>] [--json]
      List every filament preset and whether Studio can show it.
  preset-doctor fix [folder] [--user <id>] [--dry-run]
      Show the repairs Preset Doctor is confident about, as diffs. Writes nothing.
  preset-doctor fix [folder] [--user <id>] --apply --yes [--no-base-id]
      Back up the user folder, then make those repairs. Close Bambu Studio first.
  preset-doctor backups [list]
      List backups made before repairs.
  preset-doctor backups restore <id> [folder] --yes [--from-other-folder]
      Put a backup back (the current state is backed up first). A backup made from another
      folder is refused unless --from-other-folder is given.

Options:
  folder           Bambu Studio data folder. Default: %APPDATA%\\BambuStudio
  --user <id>      Account folder under user\\ to check. Default: the one with most presets.
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
  4  refused for safety (Bambu Studio is running, files changed meanwhile, or a backup
     came from another folder)
`;

interface Args {
  positional: string[];
  user?: string;
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
  const flags: Record<string, keyof Args> = {
    '--json': 'json',
    '--dry-run': 'dryRun',
    '--apply': 'apply',
    '--yes': 'yes',
    '-y': 'yes',
    '--no-base-id': 'noBaseId',
    '--from-other-folder': 'fromOtherFolder',
    '--help': 'help',
    '-h': 'help',
    '--version': 'version',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? a.split(/=(.*)/s) : [a];
    if (flag === '--user' || flag === '--backups') {
      const value = inline ?? argv[++i];
      if (value === undefined || value === '') throw new UsageError(`${flag} needs a value.`);
      if (flag === '--user') args.user = value;
      else args.backups = value;
    } else if (flag !== undefined && flag in flags) {
      (args as unknown as Record<string, boolean>)[flags[flag]!] = true;
    } else if (a.startsWith('-') && a !== '-') {
      throw new UsageError(`Unknown option ${a}.`);
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

export async function main(argv: readonly string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const d: CliDeps = {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    paths: deps.paths ?? defaultPaths(),
    isStudioRunning: () => isStudioRunning(),
    now: () => new Date(),
    ...deps,
  };
  const out = (line = ''): void => d.stdout(line + '\n');
  const err = (line: string): void => d.stderr(line + '\n');

  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`${(e as Error).message} Run "preset-doctor --help" for usage.`);
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
    err(
      e instanceof ScanError || e instanceof FixError
        ? e.message
        : `Error: ${(e as Error).message}`,
    );
    return EXIT.failed;
  }
}

function rootArg(rest: string[], d: CliDeps): string {
  if (rest.length > 1) throw new UsageError(`Too many arguments: ${rest.join(' ')}.`);
  return rest[0] ?? d.paths.studioRoot;
}

async function runScan(root: string, args: Args): Promise<ScanResult> {
  const fs = nodeFs(root, { readOnly: true });
  if (!(await fs.exists(''))) throw new ScanError(`The folder ${root} does not exist.`);
  return scan(fs, args.user !== undefined ? { userId: args.user, root } : { root });
}

async function scanCommand(
  args: Args,
  rest: string[],
  d: CliDeps,
  out: (l?: string) => void,
): Promise<number> {
  const result = await runScan(rootArg(rest, d), args);
  if (args.json) out(JSON.stringify(result, null, 2));
  else printScan(result, args, out);
  // Without the system index no parent was checked: a clean exit would claim nothing is hidden.
  if (!result.systemIndexRead && result.presets.some((p) => p.inherits)) {
    if (!args.json) {
      out();
      out(
        'INCOMPLETE: the system presets could not be read, so Preset Doctor could not check ' +
          'whether the parent presets still exist. Open Bambu Studio once, close it, and scan again.',
      );
    }
    return EXIT.failed;
  }
  const bad = result.presets.some((p) => p.status === 'hidden' || p.status === 'broken');
  return bad ? EXIT.problems : EXIT.ok;
}

const GROUPS: { status: PresetStatus; label: string }[] = [
  { status: 'hidden', label: 'Hidden in Studio' },
  { status: 'broken', label: 'Broken' },
  { status: 'info', label: 'OK, with notes' },
  { status: 'ok', label: 'OK' },
];

function printScan(r: ScanResult, args: Args, out: (l?: string) => void): void {
  printHeader(r, out);
  const byPath = new Map<string, Finding[]>();
  for (const f of r.findings) {
    const list = byPath.get(f.presetPath);
    if (list) list.push(f);
    else byPath.set(f.presetPath, [f]);
  }

  for (const g of GROUPS) {
    const rows = r.presets.filter((p) => p.status === g.status);
    out();
    out(`${g.label} (${rows.length})`);
    if (rows.length === 0) continue;
    const width = Math.min(48, Math.max(...rows.map((p) => label(p).length)));
    for (const p of rows) {
      out(`  ${label(p).padEnd(width)}  ${p.reason}`);
      if (g.status === 'ok') continue;
      for (const f of byPath.get(p.path) ?? []) {
        const note = fixNote(f);
        if (note) out(`  ${''.padEnd(width)}  ${note}`);
      }
    }
  }

  const count = (s: PresetStatus): number => r.presets.filter((p) => p.status === s).length;
  out();
  out(
    `Summary: ${count('hidden')} hidden, ${count('broken')} broken, ` +
      `${count('info')} OK with notes, ${count('ok')} OK.`,
  );
  if (r.findings.some((f) => f.proposedFix)) {
    out(`To preview repairs: ${fixHint(r.root, args, r, '--dry-run')}`);
  }
}

function printHeader(r: ScanResult, out: (l?: string) => void): void {
  out(`Preset Doctor ${VERSION}`);
  out(`Folder:  ${r.root}`);
  out(`System presets: ${r.systemVersion ? `version ${r.systemVersion}` : 'could not be read'}`);
  const me = r.accounts.find((a) => a.id === r.userId);
  const others = r.accounts.filter((a) => a.id !== r.userId);
  out(
    `Account: ${r.userId || '(none)'}${me ? ` (${me.presetCount} presets)` : ''}` +
      (others.length
        ? `; others: ${others.map((a) => `${a.id} (${a.presetCount})`).join(', ')}`
        : ''),
  );
  for (const f of r.findings.filter((x) => x.ruleId === R5_ID)) {
    out();
    out(`WARNING: ${f.title}. ${f.explanation}`);
  }
  for (const w of r.warnings) out(`Note: ${w}`);
}

function label(p: PresetSummary): string {
  return (p.name ?? fileStem(p.path)) + (p.isBase ? ' [base]' : '');
}

function fixNote(f: Finding): string | undefined {
  const fix = f.proposedFix;
  if (fix?.kind === 'renamePreset') return `fix: rename to "${fix.newName}"`;
  if (fix?.kind !== 'setInherits')
    return f.status === 'hidden' && f.severity === 'error' ? 'no replacement found' : undefined;
  const pick = fix.candidates.find((c) => c.preselected);
  if (pick) return `fix: switch parent to "${pick.name}" (${pick.confidence} confidence)`;
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
  const root = rootArg(rest, d);
  const result = await runScan(root, args);
  const choices = defaultChoices(result);
  const readFs = nodeFs(root, { readOnly: true });
  const changes = await planFixes(readFs, result, choices, { updateBaseId: !args.noBaseId });

  printHeader(result, out);
  const unfixable = result.findings.filter(
    (f) =>
      (f.status === 'hidden' || f.status === 'broken') &&
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
        `To make these repairs, close Bambu Studio and run: ${fixHint(root, args, result, '--apply --yes')}`,
      );
    }
    return EXIT.ok;
  }
  if (!args.yes) throw new UsageError('Add --yes to confirm that these files should be changed.');

  if (!(await studioClosed(d, err))) return EXIT.refused;

  const writeFs = nodeFs(root);
  const backupsDir = args.backups ?? d.paths.backupsDir;
  const backup = await createBackup(writeFs, nodeFs(backupsDir), {
    now: d.now(),
    reason: 'before-fix',
    sourceRoot: nodePath.resolve(root),
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
      err(`${e.message}`);
      err(`Already changed: ${e.written.join(', ') || 'nothing'}.`);
      err(
        `To undo: preset-doctor backups restore ${backup.id} ${quote(root)}${backupsFlag(args)} --yes`,
      );
      return EXIT.failed;
    }
    throw e;
  }
  out(
    `To undo: preset-doctor backups restore ${backup.id} ${quote(root)}${backupsFlag(args)} --yes`,
  );
  out('Next: open Bambu Studio and check that the presets are back.');
  if (result.findings.some((f) => f.ruleId === R5_ID)) {
    out('Cloud preset sync is on: if a repair comes undone, turn sync off and repair again.');
  }
  return EXIT.ok;
}

async function studioClosed(d: CliDeps, err: (l: string) => void): Promise<boolean> {
  let running: boolean;
  try {
    running = await d.isStudioRunning();
  } catch (e) {
    err(
      `Could not check whether Bambu Studio is running (${(e as Error).message}), so nothing was changed.`,
    );
    return false;
  }
  if (running) err('Bambu Studio is running. Close it and run this again; nothing was changed.');
  return !running;
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
          `${(b.reason ?? '').padEnd(14)}  from ${b.sourceRoot ?? '(unknown folder)'}`,
      );
    }
    return EXIT.ok;
  }

  if (sub === 'restore') {
    const [id, ...folder] = more;
    if (id === undefined)
      throw new UsageError('Which backup? Usage: preset-doctor backups restore <id>');
    const root = rootArg(folder, d);
    if (!args.yes)
      throw new UsageError('Add --yes to confirm that the user folder should be replaced.');
    if (!(await studioClosed(d, err))) return EXIT.refused;
    let result;
    try {
      result = await restoreBackup(nodeFs(root), destFs, id, {
        now: d.now(),
        expectedRoot: nodePath.resolve(root),
        allowOtherSource: args.fromOtherFolder,
      });
    } catch (e) {
      if (e instanceof RestoreError) {
        err(e.message);
        if (e.safetyBackup) {
          err(
            `To go back to how it was before this restore: preset-doctor backups restore ${e.safetyBackup.id} ${quote(root)}${backupsFlag(args)} --yes`,
          );
        }
        return EXIT.failed;
      }
      if (!(e instanceof BackupSourceError)) throw e;
      err(e.message);
      err(
        `To restore it into ${e.sourceRoot}: preset-doctor backups restore ${id} ${quote(e.sourceRoot)}${backupsFlag(args)} --yes`,
      );
      err('To put it into this folder anyway, add --from-other-folder.');
      return EXIT.refused;
    }
    out(`Restored ${result.restoredCount} files from backup ${id} into ${root}.`);
    if (result.safetyBackup) {
      out(`The state before the restore was saved as backup ${result.safetyBackup.id}.`);
    }
    return EXIT.ok;
  }

  throw new UsageError(`Unknown backups command "${sub}".`);
}

/**
 * The `fix` command to run next, with the same account, base_id and backups options as this
 * run: without --user, scan would pick the account with the most presets, which may not be the
 * one just previewed.
 */
function fixHint(root: string, args: Args, result: ScanResult, mode: string): string {
  const user =
    args.user !== undefined || result.accounts.length > 1 ? ` --user ${quote(result.userId)}` : '';
  return (
    `preset-doctor fix ${quote(root)}${user} ${mode}` +
    (args.noBaseId ? ' --no-base-id' : '') +
    backupsFlag(args)
  );
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
      process.stderr.write(`Error: ${(e as Error).message}\n`);
      process.exitCode = EXIT.failed;
    },
  );
}
