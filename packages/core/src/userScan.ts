import {
  errorMessage,
  InvalidUtf8Error,
  isFolderError,
  isNotFound,
  joinPath,
  readTextStrict,
  type PresetFs,
} from './fs.js';
import { parseInfoFile } from './infoFile.js';
import { isRecord, tryParseJsonFile } from './jsonFile.js';
import type { AccountSummary, UserPreset } from './types.js';

/** Root-relative folder holding one folder per account (plus 'default' when logged out). */
const USER_DIR = 'user';

/** The two places Studio keeps filament presets for an account. */
const FILAMENT_DIRS = [
  { sub: 'filament', isBase: false },
  { sub: 'filament/base', isBase: true },
] as const;

interface PresetFile {
  path: string;
  fileStem: string;
  isBase: boolean;
}

/** Where the .info sync file of the preset at `jsonPath` (ending in .json, any case) is. */
export function infoPathFor(jsonPath: string): string {
  return `${jsonPath.slice(0, -'.json'.length)}.info`;
}

/**
 * Every account folder under user/, with its filament preset count, most presets first (F7:
 * user/default often exists but is empty, so the busiest account is the sensible default pick).
 * Returns [] when there is no user/ folder.
 */
export async function listAccounts(fs: PresetFs): Promise<AccountSummary[]> {
  const entries = await listOrEmpty(fs, USER_DIR);
  const accounts = await Promise.all(
    entries
      .filter((e) => e.kind === 'dir')
      .map(async (e) => ({ id: e.name, presetCount: (await presetFiles(fs, e.name)).length })),
  );
  return accounts.sort(compareAccounts);
}

/** Most presets first; ties put real (numeric) account ids before 'default', then by id. */
function compareAccounts(a: AccountSummary, b: AccountSummary): number {
  if (a.presetCount !== b.presetCount) return b.presetCount - a.presetCount;
  const aDefault = a.id === 'default' ? 1 : 0;
  const bDefault = b.id === 'default' ? 1 : 0;
  if (aDefault !== bDefault) return aDefault - bDefault;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Reads every filament preset of one account (filament/*.json, then filament/base/*.json),
 * each paired with its .info sidecar when present. Never throws for a bad file: unreadable
 * or invalid JSON is reported through `parseError`, and an unreadable sidecar through
 * `infoError`, so the rules can explain it.
 */
export async function scanUser(fs: PresetFs, accountId: string): Promise<UserPreset[]> {
  const files = await presetFiles(fs, accountId);
  return Promise.all(files.map((f) => readPreset(fs, accountId, f)));
}

async function presetFiles(fs: PresetFs, accountId: string): Promise<PresetFile[]> {
  assertAccountId(accountId);
  const out: PresetFile[] = [];
  for (const { sub, isBase } of FILAMENT_DIRS) {
    const dir = joinPath(USER_DIR, accountId, sub);
    for (const e of await listOrEmpty(fs, dir)) {
      if (e.kind !== 'file' || !e.name.toLowerCase().endsWith('.json')) continue;
      out.push({ path: joinPath(dir, e.name), fileStem: e.name.slice(0, -5), isBase });
    }
  }
  return out;
}

async function readPreset(fs: PresetFs, accountId: string, f: PresetFile): Promise<UserPreset> {
  const infoPath = infoPathFor(f.path);
  const preset: UserPreset = {
    accountId,
    path: f.path,
    fileStem: f.fileStem,
    isBase: f.isBase,
    raw: '',
    infoPath,
  };

  try {
    preset.raw = await readTextStrict(fs, f.path);
  } catch (err) {
    // Studio can't load a file that isn't valid UTF-8 either, so report it as damaged.
    preset.parseError =
      err instanceof InvalidUtf8Error
        ? err.message
        : `Could not read the file: ${errorMessage(err)}`;
    return preset;
  }

  const parsed = tryParseJsonFile(preset.raw);
  if (!parsed.ok) {
    preset.parseError = parsed.error;
  } else {
    preset.format = parsed.format;
    if (isRecord(parsed.value)) preset.json = parsed.value;
    else preset.parseError = 'The file is valid JSON but not a JSON object.';
  }

  try {
    const infoRaw = await readOptional(fs, infoPath);
    if (infoRaw !== undefined) {
      preset.infoRaw = infoRaw;
      preset.info = parseInfoFile(infoRaw);
    }
  } catch (err) {
    // Locked by OneDrive or an antivirus, or a folder named *.info: say so, don't fail the scan.
    preset.infoError = errorMessage(err);
    if (isFolderError(err)) preset.infoIsFolder = true;
  }
  return preset;
}

async function listOrEmpty(fs: PresetFs, dir: string): ReturnType<PresetFs['list']> {
  try {
    return await fs.list(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

async function readOptional(fs: PresetFs, path: string): Promise<string | undefined> {
  try {
    return await fs.readText(path);
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

function assertAccountId(id: string): void {
  if (id === '' || id === '.' || id === '..' || /[\\/]/.test(id)) {
    throw new Error(`Invalid account id: ${JSON.stringify(id)}`);
  }
}
