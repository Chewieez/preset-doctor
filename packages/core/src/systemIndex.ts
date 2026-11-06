/**
 * The system preset index: system/<vendor>.json lists every system preset by name and file.
 *
 * Names come straight from the index, so "does this parent exist?" needs no file reads. Preset
 * bodies (setting_id, inherits, compatible_printers) are read lazily and cached, because R1 only
 * needs a handful of siblings per orphan; loadAll() is there for callers that want everything.
 */
import { dirname, errorMessage, isNotFound, joinPath, type PresetFs } from './fs.js';
import { isRecord, stripBom } from './jsonFile.js';
import {
  modelMatchesCode,
  parseCompatiblePrinter,
  parsePresetName,
  type ParsedPresetName,
} from './names.js';

export interface SystemIndexOptions {
  /** Vendor folder and index file name. Default 'BBL'. */
  vendor?: string;
  /** Index list to read. Default 'filament_list'. */
  listKey?: string;
  /** Check that every listed file exists (one folder listing per folder). Default true. */
  checkFiles?: boolean;
}

export interface SystemEntry {
  name: string;
  /** As written in the index, relative to system/<vendor>/, e.g. 'filament/P1P/Foo.json'. */
  subPath: string;
  /** Root-relative path, e.g. 'system/BBL/filament/P1P/Foo.json'. */
  path: string;
}

/** The parts of a system preset body the rules need. */
export interface SystemPreset extends SystemEntry {
  settingId?: string;
  /** Empty string means "no parent". */
  inherits: string;
  /** Only when the file itself sets it; see effectiveCompatiblePrinters for the inherited value. */
  compatiblePrinters?: string[];
  instantiation: boolean;
}

export class SystemIndexError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SystemIndexError';
  }
}

export interface SystemIndex {
  vendor: string;
  /** Root-relative path of the index file, e.g. 'system/BBL.json'. */
  indexPath: string;
  /** Profile version from the index, e.g. '02.08.00.06'. */
  version: string | null;
  /** Non-fatal problems: missing or unreadable files, inherit cycles. Grows as bodies load. */
  warnings: string[];
  /** Index entries whose file is missing. They are not in `entries`: Studio can't load them. */
  missing: SystemEntry[];
  entries: ReadonlyMap<string, SystemEntry>;

  has(name: string): boolean;
  get(name: string): SystemEntry | undefined;
  names(): string[];
  /** Cached parse of a name from the index (null for templates and @base). */
  parsed(name: string): ParsedPresetName | null;
  /** Index names with this stem (case-insensitive), in index order. */
  namesWithStem(stem: string): string[];

  /** Reads and caches one body; null (plus a warning) if absent, unreadable or not JSON. */
  load(name: string): Promise<SystemPreset | null>;
  loadAll(): Promise<SystemPreset[]>;
  /**
   * compatible_printers from the nearest preset in the chain that sets it. An empty array is a
   * real value (fdm_filament_common sets []). null when no preset in the chain sets it.
   */
  effectiveCompatiblePrinters(name: string): Promise<string[] | null>;
  /** Full model for a vendor tag and code, e.g. ('BBL', 'X1C') -> 'Bambu Lab X1 Carbon'. */
  printerModel(vendorTag: string, printerCode: string): Promise<string | null>;
  /** Model for a parsed name: spelled out (wizard names) or looked up from its code. */
  modelOf(parsed: ParsedPresetName): Promise<string | null>;
}

const MAX_CHAIN = 32;
const LOAD_CONCURRENCY = 32;

export async function loadSystemIndex(
  fs: PresetFs,
  options: SystemIndexOptions = {},
): Promise<SystemIndex> {
  const vendor = options.vendor ?? 'BBL';
  const listKey = options.listKey ?? 'filament_list';
  const indexPath = joinPath('system', `${vendor}.json`);
  const vendorDir = joinPath('system', vendor);

  const index = await readIndex(fs, indexPath);
  const warnings: string[] = [];
  const listed = readList(index, listKey, indexPath, vendorDir, warnings);

  let missing: SystemEntry[] = [];
  if (options.checkFiles ?? true) {
    const { present, unreadable } = await existingFiles(fs, listed);
    // An unreadable folder, or not one listed file present (system/BBL not copied, a broken
    // update), means the presets can't be checked, not that every parent is gone.
    if (unreadable) {
      throw new SystemIndexError(
        `Could not read the system presets in ${unreadable.dir} (${unreadable.message}).`,
      );
    }
    missing = listed.filter((e) => !present.has(e.path.toLowerCase()));
    if (listed.length > 0 && missing.length === listed.length) {
      throw new SystemIndexError(
        `None of the ${listed.length} system presets listed in ${indexPath} were found: the ` +
          `system\\${vendor} folder is missing or incomplete.`,
      );
    }
    for (const e of missing) {
      warnings.push(
        `System preset "${e.name}" is listed in ${indexPath} but ${e.path} is missing.`,
      );
    }
  }
  const missingNames = new Set(missing.map((e) => e.name));
  const entries = new Map<string, SystemEntry>();
  for (const e of listed) if (!missingNames.has(e.name)) entries.set(e.name, e);

  const parsedCache = new Map<string, ParsedPresetName | null>();
  const parsed = (name: string): ParsedPresetName | null => {
    if (!parsedCache.has(name)) parsedCache.set(name, parsePresetName(name));
    return parsedCache.get(name) ?? null;
  };

  let stemMap: Map<string, string[]> | undefined;
  const namesWithStem = (stem: string): string[] => {
    if (!stemMap) {
      stemMap = new Map();
      for (const name of entries.keys()) {
        const key = parsed(name)?.stem.toLowerCase();
        if (key === undefined) continue;
        const list = stemMap.get(key);
        if (list) list.push(name);
        else stemMap.set(key, [name]);
      }
    }
    return [...(stemMap.get(stem.toLowerCase()) ?? [])];
  };

  const bodies = new Map<string, Promise<SystemPreset | null>>();
  const load = (name: string): Promise<SystemPreset | null> => {
    let p = bodies.get(name);
    if (!p) {
      const entry = entries.get(name);
      p = entry ? readBody(fs, entry, warnings) : Promise.resolve(null);
      bodies.set(name, p);
    }
    return p;
  };

  const cycleWarned = new Set<string>();
  /** Walks up from `name` until `stop` returns true, the chain ends, or it loops. */
  const walk = async (
    name: string,
    stop: (p: SystemPreset) => boolean = () => false,
  ): Promise<SystemPreset[]> => {
    const out: SystemPreset[] = [];
    const seen = new Set<string>();
    let current: string = name;
    while (current !== '' && out.length < MAX_CHAIN) {
      if (seen.has(current)) {
        if (!cycleWarned.has(name)) {
          cycleWarned.add(name);
          warnings.push(`System preset "${name}" has an inherits loop at "${current}".`);
        }
        break;
      }
      seen.add(current);
      const body = await load(current);
      if (!body) break;
      out.push(body);
      if (stop(body)) break;
      current = body.inherits;
    }
    return out;
  };

  // Stops at the first preset that sets it, so most lookups read a single file.
  const effectiveCompatiblePrinters = async (name: string): Promise<string[] | null> =>
    (await walk(name, (p) => p.compatiblePrinters !== undefined)).at(-1)?.compatiblePrinters ??
    null;

  const modelCache = new Map<string, Promise<string | null>>();
  const printerModel = (vendorTag: string, printerCode: string): Promise<string | null> => {
    const key = `${vendorTag} ${printerCode}`;
    let p = modelCache.get(key);
    if (!p) {
      const names = [...entries.keys()].filter((n) => {
        const pn = parsed(n);
        return (
          pn?.model === undefined && pn?.vendorTag === vendorTag && pn.printerCode === printerCode
        );
      });
      p = mapLimit(names, LOAD_CONCURRENCY, effectiveCompatiblePrinters).then((lists) =>
        pickModel(printerCode, lists),
      );
      modelCache.set(key, p);
    }
    return p;
  };

  const modelOf = async (pn: ParsedPresetName): Promise<string | null> => {
    if (pn.model !== undefined) return pn.model;
    if (pn.vendorTag === undefined || pn.printerCode === undefined) return null;
    return printerModel(pn.vendorTag, pn.printerCode);
  };

  return {
    vendor,
    indexPath,
    version: typeof index['version'] === 'string' ? index['version'] : null,
    warnings,
    missing,
    entries,
    has: (name) => entries.has(name),
    get: (name) => entries.get(name),
    names: () => [...entries.keys()],
    parsed,
    namesWithStem,
    load,
    loadAll: async () =>
      (await mapLimit([...entries.keys()], LOAD_CONCURRENCY, load)).filter(
        (p): p is SystemPreset => p !== null,
      ),
    effectiveCompatiblePrinters,
    printerModel,
    modelOf,
  };
}

async function readIndex(fs: PresetFs, indexPath: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await fs.readText(indexPath);
  } catch (err) {
    if (isNotFound(err)) {
      throw new SystemIndexError(
        `Could not read ${indexPath}. Is this a Bambu Studio folder, and has Studio been opened at least once?`,
        { cause: err },
      );
    }
    throw new SystemIndexError(`Could not read ${indexPath}: ${errorMessage(err)}`, { cause: err });
  }
  let value: unknown;
  try {
    value = JSON.parse(stripBom(text));
  } catch (err) {
    throw new SystemIndexError(`${indexPath} is not valid JSON: ${errorMessage(err)}`);
  }
  if (!isRecord(value)) throw new SystemIndexError(`${indexPath} is not a JSON object.`);
  return value;
}

function readList(
  index: Record<string, unknown>,
  listKey: string,
  indexPath: string,
  vendorDir: string,
  warnings: string[],
): SystemEntry[] {
  const list = index[listKey];
  if (!Array.isArray(list)) throw new SystemIndexError(`${indexPath} has no "${listKey}" list.`);
  const out: SystemEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (
      !isRecord(item) ||
      typeof item['name'] !== 'string' ||
      typeof item['sub_path'] !== 'string'
    ) {
      warnings.push(`${indexPath} has a malformed "${listKey}" entry: ${JSON.stringify(item)}`);
      continue;
    }
    const name = item['name'];
    const subPath = item['sub_path'];
    if (seen.has(name)) {
      warnings.push(`${indexPath} lists "${name}" more than once; using the first.`);
      continue;
    }
    seen.add(name);
    out.push({ name, subPath, path: joinPath(vendorDir, subPath.replace(/\\/g, '/')) });
  }
  return out;
}

/**
 * Lowercased paths of the listed files that exist, using one listing per folder rather than one
 * exists() per file. Lowercased because Windows (where Studio runs) ignores case.
 */
async function existingFiles(
  fs: PresetFs,
  entries: SystemEntry[],
): Promise<{ present: Set<string>; unreadable: { dir: string; message: string } | null }> {
  const dirs = new Set(entries.map((e) => dirname(e.path)));
  const present = new Set<string>();
  let unreadable: { dir: string; message: string } | null = null;
  await mapLimit([...dirs], LOAD_CONCURRENCY, async (dir) => {
    let listing;
    try {
      listing = await fs.list(dir);
    } catch (err) {
      // A missing folder just means its presets are missing; any other error means unknown.
      if (!isNotFound(err)) unreadable ??= { dir, message: errorMessage(err) };
      return;
    }
    for (const f of listing) {
      if (f.kind === 'file') present.add(joinPath(dir, f.name).toLowerCase());
    }
  });
  return { present, unreadable };
}

async function readBody(
  fs: PresetFs,
  entry: SystemEntry,
  warnings: string[],
): Promise<SystemPreset | null> {
  let json: unknown;
  try {
    json = JSON.parse(stripBom(await fs.readText(entry.path)));
  } catch (err) {
    warnings.push(`System preset "${entry.name}" could not be read (${errorMessage(err)}).`);
    return null;
  }
  if (!isRecord(json)) {
    warnings.push(`System preset "${entry.name}" is not a JSON object.`);
    return null;
  }
  if (json['name'] !== undefined && json['name'] !== entry.name) {
    warnings.push(
      `System preset file ${entry.path} is named "${String(json['name'])}" but listed as "${entry.name}".`,
    );
  }
  const preset: SystemPreset = {
    ...entry,
    inherits: str(json['inherits']) ?? '',
    instantiation: json['instantiation'] === 'true' || json['instantiation'] === true,
  };
  const settingId = str(json['setting_id']);
  if (settingId !== undefined) preset.settingId = settingId;
  const cp = json['compatible_printers'];
  if (Array.isArray(cp)) preset.compatiblePrinters = cp.filter((x) => typeof x === 'string');
  return preset;
}

/**
 * Picks the model a printer code stands for from the compatible_printers of its presets.
 * A model whose abbreviation equals the code wins ("X1 Carbon" for X1C, even though X1C presets
 * also list X1, P1S and X1E); otherwise the model listed most often.
 */
function pickModel(code: string, lists: (string[] | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const list of lists) {
    const models = new Set<string>();
    for (const entry of list ?? []) {
      const cp = parseCompatiblePrinter(entry);
      if (cp) models.add(cp.model);
    }
    for (const m of models) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestScore = -1;
  for (const [model, count] of counts) {
    const score = (modelMatchesCode(model, code) ? 1e9 : 0) + count;
    if (score > bestScore) {
      best = model;
      bestScore = score;
    }
  }
  return best;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Every vendor index Studio has installed: system/BBL.json first, then each other
 * system/<Vendor>.json that has a matching system/<Vendor>/ folder (Studio copies a vendor
 * there once one of its printers is enabled, e.g. Creality or Prusa). Presets can inherit from
 * any of them, so names resolve across all.
 *
 * BBL failing to load throws (as loadSystemIndex does); another vendor failing only adds a
 * warning. With BBL alone this returns the BBL index itself.
 */
export async function loadSystemIndexes(
  fs: PresetFs,
  options: Omit<SystemIndexOptions, 'vendor'> = {},
): Promise<SystemIndex> {
  const bbl = await loadSystemIndex(fs, options);
  const extra: SystemIndex[] = [];
  const loadWarnings: string[] = [];
  for (const vendor of await otherVendors(fs)) {
    try {
      extra.push(await loadSystemIndex(fs, { ...options, vendor }));
    } catch (err) {
      if (!(err instanceof SystemIndexError)) throw err;
      loadWarnings.push(
        `${err.message} Presets based on ${vendor} system presets can't be checked.`,
      );
    }
  }
  if (extra.length === 0 && loadWarnings.length === 0) return bbl;
  return combineIndexes([bbl, ...extra], loadWarnings);
}

/** Vendor names with both system/<Vendor>.json and system/<Vendor>/, other than BBL. */
async function otherVendors(fs: PresetFs): Promise<string[]> {
  let listing;
  try {
    listing = await fs.list('system');
  } catch {
    return [];
  }
  const dirs = new Set(listing.filter((e) => e.kind === 'dir').map((e) => e.name.toLowerCase()));
  return listing
    .filter((e) => e.kind === 'file' && e.name.toLowerCase().endsWith('.json'))
    .map((e) => e.name.slice(0, -'.json'.length))
    .filter((v) => v.toLowerCase() !== 'bbl' && dirs.has(v.toLowerCase()));
}

/** One SystemIndex over several vendors. Each name belongs to the first index that lists it. */
function combineIndexes(parts: SystemIndex[], loadWarnings: string[]): SystemIndex {
  const first = parts[0]!;
  const owner = (name: string): SystemIndex | undefined => parts.find((p) => p.has(name));
  const entries = new Map<string, SystemEntry>();
  for (const p of parts) for (const [n, e] of p.entries) if (!entries.has(n)) entries.set(n, e);
  const firstNonNull = async <T>(fn: (p: SystemIndex) => Promise<T | null>): Promise<T | null> => {
    for (const p of parts) {
      const v = await fn(p);
      if (v !== null) return v;
    }
    return null;
  };

  return {
    vendor: first.vendor,
    indexPath: first.indexPath,
    version: first.version,
    // A getter, because each part's warnings grow as bodies load.
    get warnings() {
      return [...loadWarnings, ...parts.flatMap((p) => p.warnings)];
    },
    missing: parts.flatMap((p) => p.missing),
    entries,
    has: (name) => entries.has(name),
    get: (name) => entries.get(name),
    names: () => [...entries.keys()],
    parsed: (name) => (owner(name) ?? first).parsed(name),
    namesWithStem: (stem) =>
      parts.flatMap((p) => p.namesWithStem(stem).filter((n) => owner(n) === p)),
    load: (name) => owner(name)?.load(name) ?? Promise.resolve(null),
    loadAll: async () => {
      const lists = await Promise.all(parts.map((p) => p.loadAll()));
      return lists.flatMap((list, i) => list.filter((b) => owner(b.name) === parts[i]));
    },
    effectiveCompatiblePrinters: (name) =>
      owner(name)?.effectiveCompatiblePrinters(name) ?? Promise.resolve(null),
    printerModel: (tag, code) => firstNonNull((p) => p.printerModel(tag, code)),
    modelOf: (pn) => firstNonNull((p) => p.modelOf(pn)),
  };
}
