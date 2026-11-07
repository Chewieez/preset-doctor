import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as nodePath from 'node:path';
import { BAMBU, ORCA, type SlicerProfile } from '../slicer.js';

/** Process names Bambu Studio has used. Compared case-insensitively, with or without `.exe`. */
export const STUDIO_PROCESS_NAMES = BAMBU.processNames;

/** Runs a program and resolves with its stdout. Injectable so tests need no real processes. */
export type CommandRunner = (file: string, args: string[]) => Promise<string>;

export interface StudioProcessOptions {
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  /** For finding %SystemRoot%. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Default fs.existsSync. */
  fileExists?: (path: string) => boolean;
}

/**
 * The process-list program, by absolute path. A bare "tasklist" would also be looked up in the
 * current folder first on Windows, so a planted tasklist.exe (say, in Downloads) would run and
 * could claim Studio is closed.
 */
export function processListProgram(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): string {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
    return nodePath.win32.join(systemRoot, 'System32', 'tasklist.exe');
  }
  return fileExists('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
}

/** How long the process list may take; tasklist can hang on a stalled WMI. */
export const PROCESS_LIST_TIMEOUT_MS = 10_000;

/**
 * Runs a program and resolves with its stdout, killing it and rejecting after `timeoutMs`. The
 * timeout matters: the desktop app polls Studio's state one check at a time, and apply/restore
 * check it inside the write queue, so a check that never settles would freeze both.
 */
export function runCommand(
  file: string,
  args: string[],
  timeoutMs = PROCESS_LIST_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

const defaultRunner: CommandRunner = (file, args) => runCommand(file, args);

/**
 * True when Bambu Studio is running. Throws if the process list cannot be read, so callers can
 * tell "not running" apart from "could not check" and refuse to write in the second case.
 */
export function isStudioRunning(options: StudioProcessOptions = {}): Promise<boolean> {
  return isSlicerRunning(BAMBU, options);
}

/**
 * True when the slicer is running (any of its process names). Throws if the process list cannot
 * be read, like isStudioRunning. OrcaSlicer's lock files (user.lock, OrcaSlicer.conf.lock) are
 * held only while it writes (src/libslic3r/InstanceLock.hpp:9-22@v2.5.0), so only the process
 * list can tell.
 */
export async function isSlicerRunning(
  profile: SlicerProfile,
  options: StudioProcessOptions = {},
): Promise<boolean> {
  const names = await processNames(options);
  return names.some((n) => isSlicerProcessName(profile, n));
}

/** Every process name on the system (one process-list call). */
async function processNames(options: StudioProcessOptions): Promise<string[]> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunner;
  const program = processListProgram(platform, options.env, options.fileExists);
  const names =
    platform === 'win32'
      ? // Unfiltered list: one call covers every name, and the CSV first column is not localized.
        parseTasklistCsv(await run(program, ['/FO', 'CSV', '/NH']))
      : parsePsOutput(await run(program, ['-A', '-o', 'comm=']));
  // An unfiltered list always has system processes, so an empty one means it couldn't be read.
  if (names.length === 0) throw new Error('Could not read the process list.');
  return names;
}

export function isStudioProcessName(name: string): boolean {
  return isSlicerProcessName(BAMBU, name);
}

/** Compared case-insensitively, with or without ".exe". */
export function isSlicerProcessName(profile: SlicerProfile, name: string): boolean {
  const n = name.toLowerCase().replace(/\.exe$/, '');
  return profile.processNames.some((s) => s.toLowerCase() === n);
}

/** Image names from `tasklist /FO CSV /NH`: the first quoted field of each line. */
export function parseTasklistCsv(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^"([^"]*)"/.exec(line.trim());
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

/** Program names from `ps -A -o comm=`, which may be full paths (macOS). */
export function parsePsOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => l.slice(l.lastIndexOf('/') + 1));
}

export interface DefaultPaths {
  /** The Bambu Studio data folder (contains `user/` and `system/`). */
  studioRoot: string;
  /** The OrcaSlicer data folder, laid out the same way. */
  orcaRoot: string;
  /** Where Preset Doctor keeps its backup zips. Deliberately outside the Bambu Studio folder. */
  backupsDir: string;
}

export interface DefaultPathsOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Windows: `%APPDATA%\BambuStudio`, `%APPDATA%\OrcaSlicer` and `%APPDATA%\PresetDoctor\backups`.
 * OrcaSlicer uses wxStandardPaths::GetUserDataDir() with the app name "OrcaSlicer"
 * (src/slic3r/GUI/GUI_App.cpp:2744, 2779-2783@v2.5.0); its MSIX build uses the same folder
 * (scripts/msix/AppxManifest.xml:22-31@v2.5.0). Portable installs (a data_dir folder next to the
 * exe, or --datadir) are picked by hand.
 */
export function defaultPaths(options: DefaultPathsOptions = {}): DefaultPaths {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  let base: string;
  let path: typeof nodePath.win32;
  if (platform === 'win32') {
    path = nodePath.win32;
    base = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  } else {
    path = nodePath.posix;
    base =
      platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME || path.join(home, '.config');
  }
  return {
    studioRoot: path.join(base, BAMBU.rootDirName),
    orcaRoot: path.join(base, ORCA.rootDirName),
    backupsDir: path.join(base, 'PresetDoctor', 'backups'),
  };
}
