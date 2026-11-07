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
import { PRESET_TYPES, type AccountSummary, type PresetType, type UserPreset } from './types.js';

/** Root-relative folder holding one folder per account (plus 'default' when logged out). */
const USER_DIR = 'user';

/**
 * Where Studio keeps an account's presets, in the order they are read: each type's folder,
 * then its base/ folder (src/libslic3r/PresetBundle.cpp:917, 924, 931@v02.09.01.70). Filament
 * comes first, so a filament-only folder reads exactly as before.
 */
export const PRESET_DIRS: readonly { type: PresetType; sub: string; isBase: boolean }[] =
  PRESET_TYPES.flatMap((type) => [
    { type, sub: type, isBase: false },
    { type, sub: `${type}/base`, isBase: true },
  ]);

interface PresetFile {
  type: PresetType;
  path: string;
  fileStem: string;
  isBase: boolean;
}

/** Where the .info sync file of the preset at `jsonPath` (ending in .json, any case) is. */
export function infoPathFor(jsonPath: string): string {
  return `${jsonPath.slice(0, -'.json'.length)}.info`;
}

/**
 * Every account folder under user/, with its preset counts, most presets (of all types) first
 * (F7: user/default often exists but is empty, so the busiest account is the sensible default
 * pick). Returns [] when there is no user/ folder.
 */
export async function listAccounts(fs: PresetFs): Promise<AccountSummary[]> {
  const entries = await listOrEmpty(fs, USER_DIR);
  const accounts = await Promise.all(
    entries
      .filter((e) => e.kind === 'dir')
      .map(async (e): Promise<AccountSummary> => {
        const files = await presetFiles(fs, e.name);
        return { id: e.name, presetCount: files.length, byType: countTypes(files) };
      }),
  );
  return accounts.sort(compareAccounts);
}

/** How many of these presets (or files) there are of each type. */
export function countTypes(items: readonly { type: PresetType }[]): Record<PresetType, number> {
  const out: Record<PresetType, number> = { filament: 0, process: 0, machine: 0 };
  for (const i of items) out[i.type]++;
  return out;
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
 * Reads every preset of one account (see PRESET_DIRS for the order), each paired with its .info
 * sidecar when present. Never throws for a bad file: unreadable
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
  for (const { type, sub, isBase } of PRESET_DIRS) {
    const dir = joinPath(USER_DIR, accountId, sub);
    for (const e of await listOrEmpty(fs, dir)) {
      if (e.kind !== 'file' || !e.name.toLowerCase().endsWith('.json')) continue;
      out.push({ type, path: joinPath(dir, e.name), fileStem: e.name.slice(0, -5), isBase });
    }
  }
  return out;
}

async function readPreset(fs: PresetFs, accountId: string, f: PresetFile): Promise<UserPreset> {
  const infoPath = infoPathFor(f.path);
  const preset: UserPreset = {
    type: f.type,
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
