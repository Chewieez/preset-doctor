import * as nodePath from 'node:path';
import type { DefaultPaths } from '@preset-doctor/core/node';

export interface MainConfig {
  root: string;
  backupsDir: string;
  /** Started with PRESET_DOCTOR_ROOT: a test run or a copy of the folder. */
  testMode: boolean;
  /**
   * Replaces the real "is Bambu Studio running" check. Only honored in test mode, never when
   * PRESET_DOCTOR_ROOT is the real Studio folder, and (see DoctorService) only for writes to
   * that root, so an end user can never switch the safety check off on their real folder.
   */
  fakeStudioRunning: boolean | null;
}

/**
 * Environment overrides, for tests and for working on a copy of the folder:
 *   PRESET_DOCTOR_ROOT                  folder to open instead of %APPDATA%\BambuStudio
 *   PRESET_DOCTOR_BACKUPS               backups folder
 *   PRESET_DOCTOR_FAKE_STUDIO_RUNNING   '0' or '1'; ignored unless PRESET_DOCTOR_ROOT is set
 */
export function readConfig(
  env: NodeJS.ProcessEnv,
  defaults: DefaultPaths,
  platform: NodeJS.Platform = process.platform,
): MainConfig {
  const rootOverride = nonEmpty(env.PRESET_DOCTOR_ROOT);
  const backupsOverride = nonEmpty(env.PRESET_DOCTOR_BACKUPS);
  const testMode = rootOverride !== undefined;
  const fake = env.PRESET_DOCTOR_FAKE_STUDIO_RUNNING;
  // Never fake the check for the real Studio folder, even when it is named explicitly.
  const isRealFolder =
    rootOverride !== undefined && samePath(rootOverride, defaults.studioRoot, platform);
  return {
    root: rootOverride ?? defaults.studioRoot,
    backupsDir: backupsOverride ?? defaults.backupsDir,
    testMode,
    fakeStudioRunning:
      testMode && !isRealFolder && (fake === '0' || fake === '1') ? fake === '1' : null,
  };
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const norm = (p: string): string => {
    const r = path.resolve(p);
    return platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}
