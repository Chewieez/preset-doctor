import { errorMessage, isNotFound, type PresetFs } from './fs.js';
import { isRecord, stripBom } from './jsonFile.js';

/** Root-relative path of Studio's app config. */
export const STUDIO_CONF_PATH = 'BambuStudio.conf';

export interface StudioConf {
  /** False when the file does not exist. */
  found: boolean;
  /** app.sync_user_preset: Studio's cloud preset sync (SPEC section 10, question 3). */
  syncUserPreset?: boolean;
  /** Why the file could not be read or parsed, if so. The values above may still be filled in. */
  error?: string;
}

/**
 * Reads BambuStudio.conf. Never throws: the file may be missing, huge, mid-write by Studio,
 * or followed by the "# MD5 checksum ..." line Studio appends after the JSON.
 */
export async function readStudioConf(
  fs: PresetFs,
  path: string = STUDIO_CONF_PATH,
): Promise<StudioConf> {
  let text: string;
  try {
    text = await fs.readText(path);
  } catch (err) {
    if (isNotFound(err)) return { found: false };
    return { found: true, error: `Could not read ${path}: ${errorMessage(err)}` };
  }
  return parseStudioConf(text);
}

export function parseStudioConf(text: string): StudioConf {
  const json = stripTrailer(stripBom(text));
  try {
    const value: unknown = JSON.parse(json);
    const app = isRecord(value) ? value['app'] : undefined;
    if (!isRecord(app)) return { found: true, error: 'No "app" section in BambuStudio.conf.' };
    const conf: StudioConf = { found: true };
    const sync = toBool(app['sync_user_preset']);
    if (sync !== undefined) conf.syncUserPreset = sync;
    return conf;
  } catch (err) {
    // A damaged or half-written file: still try to find the one flag we care about.
    const conf: StudioConf = {
      found: true,
      error: `BambuStudio.conf is not valid JSON: ${errorMessage(err)}`,
    };
    const m = /"sync_user_preset"\s*:\s*("?)(true|false|1|0)\1/.exec(json);
    const sync = m ? toBool(m[2]) : undefined;
    if (sync !== undefined) conf.syncUserPreset = sync;
    return conf;
  }
}

/** Drops trailing lines that start with '#', e.g. "# MD5 checksum 184F...". */
function stripTrailer(text: string): string {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0) {
    const last = lines[lines.length - 1]!.trim();
    if (last === '' || last.startsWith('#')) lines.pop();
    else break;
  }
  return lines.join('\n');
}

// Older Studio versions stored booleans as strings or numbers.
function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return undefined;
}
