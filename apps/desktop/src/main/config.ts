import * as nodePath from 'node:path';
import type { SlicerId } from '@preset-doctor/core';
import type { DefaultPaths } from '@preset-doctor/core/node';

export interface MainConfig {
  /** The folder the app was started on: PRESET_DOCTOR_ROOT, or the Bambu Studio folder. */
  root: string;
  /**
   * The folder of each slicer the header can switch to: %APPDATA%\BambuStudio and
   * %APPDATA%\OrcaSlicer. In test mode only the ones named by PRESET_DOCTOR_BAMBU_ROOT and
   * PRESET_DOCTOR_ORCA_ROOT, so a test never shows or opens a real folder by accident.
   */
  slicerRoots: Partial<Record<SlicerId, string>>;
  backupsDir: string;
  /** Started with PRESET_DOCTOR_ROOT: a test run or a copy of the folder. */
  testMode: boolean;
  /**
   * Replaces the real "is the slicer running" check. Only honored in test mode, never when
   * PRESET_DOCTOR_ROOT is a real slicer folder, and (see DoctorService) only for writes to that
   * root, so an end user can never switch the safety check off on their real folder.
   */
  fakeStudioRunning: boolean | null;
}

/**
 * Environment overrides, for tests and for working on a copy of the folder:
 *   PRESET_DOCTOR_ROOT                  folder to open instead of %APPDATA%\BambuStudio (a folder
 *                                       of either slicer; its files tell which)
 *   PRESET_DOCTOR_BACKUPS               backups folder
 *   PRESET_DOCTOR_FAKE_STUDIO_RUNNING   '0' or '1'; ignored unless PRESET_DOCTOR_ROOT is set
 *   PRESET_DOCTOR_BAMBU_ROOT,
 *   PRESET_DOCTOR_ORCA_ROOT             test mode only: the folders the slicer switch offers
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
  // Never fake the check for a real slicer folder, even when it is named explicitly.
  const isRealFolder =
    rootOverride !== undefined &&
    [defaults.studioRoot, defaults.orcaRoot].some((r) => samePath(rootOverride, r, platform));
  return {
    root: rootOverride ?? defaults.studioRoot,
    slicerRoots: testMode
      ? dropUndefined({
          bambu: nonEmpty(env.PRESET_DOCTOR_BAMBU_ROOT),
          orca: nonEmpty(env.PRESET_DOCTOR_ORCA_ROOT),
        })
      : { bambu: defaults.studioRoot, orca: defaults.orcaRoot },
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

function dropUndefined(
  roots: Record<SlicerId, string | undefined>,
): Partial<Record<SlicerId, string>> {
  const out: Partial<Record<SlicerId, string>> = {};
  for (const [id, r] of Object.entries(roots) as [SlicerId, string | undefined][]) {
    if (r !== undefined) out[id] = r;
  }
  return out;
}

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}
