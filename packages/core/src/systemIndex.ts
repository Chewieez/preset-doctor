/**
 * The system preset index: system/<vendor>.json lists every system preset by name and file.
 *
 * Names come straight from the index, so "does this parent exist?" needs no file reads. Preset
 * bodies (setting_id, inherits, compatible_printers) are read lazily and cached, because R1 only
 * needs a handful of siblings per orphan; loadAll() is there for callers that want everything.
 *
 * Studio itself names a system preset by the "name" inside its file, not by the index entry
 * (`preset_name = key_values[BBL_JSON_KEY_NAME]` in PresetBundle::load_vendor_configs_from_json,
 * src/libslic3r/PresetBundle.cpp:6631@v02.09.01.70 (56a57d00), :3924@v02.00.02.57). The two only
 * differ in a few old profiles (02.00.00.83 lists "SUNLU PETG @BBL A1M" for a file whose name is
 * "SUNLU PETG @BBL A1M 0.4 nozzle"), so names stay keyed by the index and findByStudioName()
 * gives the answer Studio would, reading only the files it needs.
 */
import { dirname, errorMessage, isNotFound, joinPath, type DirEntry, type PresetFs } from './fs.js';
import { isRecord, stripBom } from './jsonFile.js';
import {
  modelMatchesCode,
  parseCompatiblePrinter,
  parsePresetName,
  type ParsedPresetName,
} from './names.js';
import { opcHasString, readOpc, type OpaqueVendor } from './opc.js';
import { BAMBU, type SlicerProfile } from './slicer.js';
import { PRESET_TYPES, type PresetType } from './types.js';

export interface SystemIndexOptions {
  /** Vendor folder and index file name. Default 'BBL'. */
  vendor?: string;
  /** Index list to read. Default 'filament_list'. */
  listKey?: string;
  /** Check that every listed file exists (one folder listing per folder). Default true. */
  checkFiles?: boolean;
  /**
   * An index without the list is an empty index rather than an error. Default false. Used for
   * process_list and machine_list, which vendor indexes may leave out.
   */
  optionalList?: boolean;
  /**
   * A vendor whose presets this vendor's system presets may inherit (OrcaSlicer's filament
   * library). Chain walks look a parent up here when this vendor doesn't list it, and stay here
   * once they have, as Orca does (src/libslic3r/PresetBundle.cpp:7797-7826@v2.5.0).
   */
  base?: SystemIndex;
}

/** The index list of each preset type in system/<vendor>.json. */
export const LIST_KEY: Record<PresetType, string> = {
  filament: 'filament_list',
  process: 'process_list',
  machine: 'machine_list',
};

export interface SystemEntry {
  name: string;
  /** As written in the index, relative to system/<vendor>/, e.g. 'filament/P1P/Foo.json'. */
  subPath: string;
  /** Root-relative path, e.g. 'system/BBL/filament/P1P/Foo.json'. */
  path: string;
  /** Vendor id of the index that lists it, e.g. 'BBL'. */
  vendor: string;
  /**
   * The parent is known to exist, but its settings can't be read: it is in an OrcaSlicer .opc
   * file, or an OrcaSlicer bundle preset (orcaLookup.ts). Such entries are never in an index.
   */
  opaque?: true;
  /** OrcaSlicer found it for another name (orcaLookup.ts): its own name, for texts. */
  currentName?: string;
}

/** The parts of a system preset body the rules need. */
export interface SystemPreset extends SystemEntry {
  /**
   * The name Studio knows this preset by: the "name" inside its file, or the index name when the
   * file has none. Almost always the same as `name` (the index name).
   */
  studioName: string;
  settingId?: string;
  /** Empty string means "no parent". */
  inherits: string;
  /** Only when the file itself sets it; see effectiveCompatiblePrinters for the inherited value. */
  compatiblePrinters?: string[];
  instantiation: boolean;
  // The fields below are set only when the file itself sets them (see effectiveValue).
  /** The file's "type" ('filament' | 'process' | 'machine'); g-code template files have none. */
  fileType?: string;
  compatiblePrintersCondition?: string;
  compatiblePrints?: string[];
  compatiblePrintsCondition?: string;
  /** Printer presets: "printer_model", e.g. 'Bambu Lab X2D'. */
  printerModel?: string;
  /** Printer presets: "printer_variant", the nozzle size, e.g. '0.4'. */
  printerVariant?: string;
  /**
   * OrcaSlicer: the old names in "renamed_from" (C-escaped, separated by ';',
   * src/libslic3r/PresetBundle.cpp:8484-8488@v2.5.0). Only when the file sets it.
   */
  renamedFrom?: string[];
  /** OrcaSlicer: the file's "alias", which stops Orca from deriving a renamed_from entry. */
  alias?: string;
}

/** SystemPreset fields that effectiveValue can resolve through the inherits chain. */
export type InheritedKey =
  | 'compatiblePrinters'
  | 'compatiblePrintersCondition'
  | 'compatiblePrints'
  | 'compatiblePrintsCondition'
  | 'printerModel'
  | 'printerVariant';

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
   * The entry of the preset Studio knows by `name` (see the module comment), or null when Studio
   * knows none. Reads the listed file; for a name that is not listed, or whose file carries another
   * name, the files listed under the same stem. A file that can't be read counts as a match: the
   * listed one when it is unreadable, else the first unreadable same-stem file when no readable
   * one carries the name. So a read error never turns an existing parent into a missing one
   * (Studio can't load such a profile either; the read error is in `warnings`).
   */
  findByStudioName(name: string): Promise<SystemEntry | null>;
  /**
   * compatible_printers from the nearest preset in the chain that sets it. An empty array is a
   * real value (fdm_filament_common sets []). null when no preset in the chain sets it.
   */
  effectiveCompatiblePrinters(name: string): Promise<string[] | null>;
  /**
   * A field from the nearest preset in the chain whose file sets it, as Studio inherits values
   * (src/libslic3r/Preset.cpp:1521-1526@v02.09.01.70); null when none does.
   */
  effectiveValue<K extends InheritedKey>(
    name: string,
    key: K,
  ): Promise<NonNullable<SystemPreset[K]> | null>;
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

  const index = await readIndex(fs, indexPath);
  const warnings: string[] = [];
  const listed =
    options.optionalList && index[listKey] === undefined
      ? []
      : readList(index, listKey, indexPath, vendor, warnings);

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

  const findByStudioName = async (name: string): Promise<SystemEntry | null> => {
    if (name === '') return null;
    const listed = entries.get(name);
    if (listed) {
      const body = await load(name);
      if (!body || body.studioName === name) return listed;
    }
    const stem = parsePresetName(name)?.stem;
    if (stem === undefined) return null;
    // In index order, as Studio loads them. Two files with the same name make Studio refuse the
    // whole vendor profile ("duplicated defines", PresetBundle.cpp:6539-6544, 6921-6927); the
    // first one is kept here, defensively.
    let unreadable: SystemEntry | undefined;
    for (const other of namesWithStem(stem)) {
      if (other === name) continue;
      const body = await load(other);
      if (body?.studioName === name) return entries.get(other) ?? null;
      if (!body) unreadable ??= entries.get(other);
    }
    // That file may be the one carrying `name`: don't call the parent missing on a guess.
    return unreadable ?? null;
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
    // Once the walk reaches the base vendor (options.base) it stays there.
    let inBase = false;
    while (current !== '' && out.length < MAX_CHAIN) {
      if (seen.has(current)) {
        if (!cycleWarned.has(name)) {
          cycleWarned.add(name);
          warnings.push(`System preset "${name}" has an inherits loop at "${current}".`);
        }
        break;
      }
      seen.add(current);
      const own = !inBase && entries.has(current);
      const body = own
        ? await load(current)
        : options.base
          ? await options.base.load(current)
          : null;
      if (!body) break;
      if (!own) inBase = true;
      out.push(body);
      if (stop(body)) break;
      current = body.inherits;
    }
    return out;
  };

  // Stops at the first preset that sets it, so most lookups read a single file.
  const effectiveValue = async <K extends InheritedKey>(
    name: string,
    key: K,
  ): Promise<NonNullable<SystemPreset[K]> | null> =>
    (await walk(name, (p) => p[key] !== undefined)).at(-1)?.[key] ?? null;
  const effectiveCompatiblePrinters = (name: string): Promise<string[] | null> =>
    effectiveValue(name, 'compatiblePrinters');

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
    findByStudioName,
    effectiveCompatiblePrinters,
    effectiveValue,
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
  vendor: string,
  warnings: string[],
): SystemEntry[] {
  const vendorDir = joinPath('system', vendor);
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
    out.push({ name, subPath, path: joinPath(vendorDir, subPath.replace(/\\/g, '/')), vendor });
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

/**
 * Studio's test for a system preset that is a real preset rather than a building block: only an
 * explicit "false" makes it a template; a missing or empty key makes it a pure include only when
 * the file's name is empty or contains "gcode" (src/libslic3r/PresetBundle.cpp:6718-6733 and
 * Preset.cpp:1505-1506@v02.09.01.70). Any other value, or no key at all, is instantiable.
 */
export function instantiable(value: unknown, fileName: string): boolean {
  if (value === undefined || value === null || value === '') {
    return !(fileName === '' || fileName.includes('gcode'));
  }
  return !(value === 'false' || value === false);
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
  const fileName = str(json['name']);
  if (json['name'] !== undefined && json['name'] !== entry.name) {
    warnings.push(
      `System preset file ${entry.path} is named "${String(json['name'])}" but listed as ` +
        `"${entry.name}"; Studio uses the name in the file.`,
    );
  }
  const preset: SystemPreset = {
    ...entry,
    studioName: fileName !== undefined && fileName !== '' ? fileName : entry.name,
    inherits: str(json['inherits']) ?? '',
    instantiation: instantiable(json['instantiation'], fileName ?? ''),
  };
  const settingId = str(json['setting_id']);
  if (settingId !== undefined) preset.settingId = settingId;
  const cp = strings(json['compatible_printers']);
  if (cp) preset.compatiblePrinters = cp;
  const prints = strings(json['compatible_prints']);
  if (prints) preset.compatiblePrints = prints;
  const optional = {
    fileType: 'type',
    compatiblePrintersCondition: 'compatible_printers_condition',
    compatiblePrintsCondition: 'compatible_prints_condition',
    printerModel: 'printer_model',
    printerVariant: 'printer_variant',
  } as const;
  for (const [field, key] of Object.entries(optional) as [keyof typeof optional, string][]) {
    const v = str(json[key]);
    if (v !== undefined) preset[field] = v;
  }
  const renamed = str(json['renamed_from']);
  if (renamed !== undefined && renamed.trim() !== '') preset.renamedFrom = splitEscaped(renamed);
  const alias = str(json['alias']);
  if (alias !== undefined && alias !== '') preset.alias = alias;
  return preset;
}

/**
 * "a;b" -> ['a', 'b'], as Orca's unescape_strings_cstyle splits renamed_from
 * (src/libslic3r/Config.cpp:173-242@v2.5.0, called at
 * src/libslic3r/PresetBundle.cpp:8484-8488@v2.5.0): spaces and tabs before an item are skipped;
 * a plain item runs up to the next ';' as written; a "quoted" item may hold ';' and backslash
 * escapes (\n, \r, otherwise the next character). Empty items are dropped; a malformed tail is
 * dropped too, keeping the items before it.
 */
export function splitEscaped(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
    if (i >= text.length) break;
    let item = '';
    if (text[i] === '"') {
      let closed = false;
      for (i++; i < text.length; i++) {
        let c = text[i]!;
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === '\\') {
          if (++i >= text.length) break;
          c = text[i]!;
          c = c === 'r' ? '\r' : c === 'n' ? '\n' : c;
        }
        item += c;
      }
      if (!closed) break;
      while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
      if (i < text.length && text[i] !== ';') {
        out.push(item);
        break;
      }
    } else {
      while (i < text.length && text[i] !== ';') item += text[i++];
    }
    out.push(item);
    i++; // the ';'
  }
  return out.filter((s) => s !== '');
}

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
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
 * warning. With BBL alone this returns the BBL index itself. This is the Bambu Studio case of
 * loadVendorIndexes.
 */
export async function loadSystemIndexes(
  fs: PresetFs,
  options: Omit<SystemIndexOptions, 'vendor'> = {},
): Promise<SystemIndex> {
  return loadVendorIndexes(fs, BAMBU, await listSystem(fs), options);
}

/** The listing of system/, or [] when it can't be listed. */
async function listSystem(fs: PresetFs): Promise<DirEntry[]> {
  try {
    return await fs.list('system');
  } catch {
    return [];
  }
}

/**
 * One list (options.listKey) of every vendor the profile loads, in its order. The required
 * vendor failing throws; another vendor failing only adds a warning.
 */
async function loadVendorIndexes(
  fs: PresetFs,
  profile: SlicerProfile,
  listing: readonly DirEntry[],
  options: Omit<SystemIndexOptions, 'vendor'>,
): Promise<SystemIndex> {
  return (await loadVendorIndexesReporting(fs, profile, listing, options)).index;
}

/** loadVendorIndexes, also naming the vendors whose index failed (each only warned about). */
async function loadVendorIndexesReporting(
  fs: PresetFs,
  profile: SlicerProfile,
  listing: readonly DirEntry[],
  options: Omit<SystemIndexOptions, 'vendor'>,
): Promise<{ index: SystemIndex; failed: string[] }> {
  const plan = profile.vendorOrder(listing);
  const failed: string[] = [];
  const parts: SystemIndex[] = [];
  const loadWarnings: string[] = [];
  let base: SystemIndex | undefined;
  for (const vendor of plan.json) {
    try {
      const part = await loadSystemIndex(fs, { ...options, vendor, ...(base ? { base } : {}) });
      parts.push(part);
      // The base vendor comes first in the plan, so every later one can inherit from it.
      if (vendor === plan.base) base = part;
    } catch (err) {
      if (!(err instanceof SystemIndexError) || vendor === plan.required) throw err;
      failed.push(vendor);
      loadWarnings.push(
        `${err.message} Presets based on ${vendor} system presets can't be checked.`,
      );
    }
  }
  const [first] = parts;
  if (first === undefined) {
    // OrcaSlicer 2.5 may keep every vendor as a .opc file only: no index to read, but the
    // presets are there (opc.ts). Parents are then checked by name only.
    if (plan.opc.length > 0) return { index: emptyIndex(plan.opc[0]!, loadWarnings), failed };
    throw new SystemIndexError('No system preset index was found.');
  }
  if (parts.length === 1 && loadWarnings.length === 0) return { index: first, failed };
  return { index: combineIndexes(parts, loadWarnings), failed };
}

/** An index that lists nothing (every vendor is a .opc file). */
function emptyIndex(vendor: string, warnings: string[]): SystemIndex {
  const none = (): Promise<null> => Promise.resolve(null);
  return {
    vendor,
    indexPath: joinPath('system', `${vendor}.opc`),
    version: null,
    warnings,
    missing: [],
    entries: new Map(),
    has: () => false,
    get: () => undefined,
    names: () => [],
    parsed: (name) => parsePresetName(name),
    namesWithStem: () => [],
    load: none,
    loadAll: () => Promise.resolve([]),
    findByStudioName: none,
    effectiveCompatiblePrinters: none,
    effectiveValue: none,
    printerModel: none,
    modelOf: none,
  };
}

/** The system index of every preset type. */
export interface SystemIndexSet {
  /** null: that type's index could not be read; `errors` says why. */
  byType: Record<PresetType, SystemIndex | null>;
  /** Why an index could not be read. */
  errors: Partial<Record<PresetType, SystemIndexError>>;
  /** Profile version of the filament index (BBL.json's "version"), as systemVersion shows. */
  version: string | null;
  /** Every index's warnings, each once. Grows as bodies load. */
  readonly warnings: string[];
  /** The vendors the profile loads (system/<V>.json and system/<V>.opc), in load order. */
  vendors: string[];
  /** OrcaSlicer 2.5: vendors present only as a .opc file (opc.ts). Empty for Bambu Studio. */
  opaque: OpaqueVendor[];
  /** Per type, the vendors whose index failed to load (a warning only; see loadVendorIndexes). */
  failedVendors: Partial<Record<PresetType, string[]>>;
  /** True when a readable .opc file holds this name (see opcHasString); false without any. */
  opcHas(name: string): boolean;
}

/**
 * Loads filament_list, process_list and machine_list of every vendor the profile loads. The
 * filament index loads exactly as loadSystemIndexes does. A vendor without a process or machine
 * list has none of those presets, which is not an error.
 */
export async function loadSystemIndexSet(
  fs: PresetFs,
  profile: SlicerProfile = BAMBU,
): Promise<SystemIndexSet> {
  const listing = await listSystem(fs);
  const byType: Record<PresetType, SystemIndex | null> = {
    filament: null,
    process: null,
    machine: null,
  };
  const errors: Partial<Record<PresetType, SystemIndexError>> = {};
  const failedVendors: Partial<Record<PresetType, string[]>> = {};
  for (const type of PRESET_TYPES) {
    try {
      const loaded = await loadVendorIndexesReporting(fs, profile, listing, {
        listKey: LIST_KEY[type],
        optionalList: type !== 'filament',
      });
      byType[type] = loaded.index;
      if (loaded.failed.length > 0) failedVendors[type] = loaded.failed;
    } catch (err) {
      if (!(err instanceof SystemIndexError)) throw err;
      errors[type] = err;
    }
  }
  const plan = profile.vendorOrder(listing);
  const opaque: OpaqueVendor[] = [];
  const bodies: Uint8Array[] = [];
  for (const vendor of plan.opc) {
    const path = joinPath('system', `${vendor}.opc`);
    let read: ReturnType<typeof readOpc> = { ok: false };
    try {
      read = readOpc(await fs.readBytes(path));
    } catch {
      // Unreadable: counted as a .opc vendor, so no parent is called missing on its account.
    }
    opaque.push({ vendor, path, readable: read.ok });
    if (read.ok) bodies.push(read.body);
  }
  return {
    byType,
    errors,
    version: byType.filament?.version ?? null,
    get warnings() {
      return [...new Set(PRESET_TYPES.flatMap((t) => byType[t]?.warnings ?? []))];
    },
    vendors: [...plan.json, ...plan.opc],
    opaque,
    failedVendors,
    opcHas: (name) => bodies.some((b) => opcHasString(b, name)),
  };
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
    findByStudioName: (name) => firstNonNull((p) => p.findByStudioName(name)),
    effectiveCompatiblePrinters: (name) =>
      owner(name)?.effectiveCompatiblePrinters(name) ?? Promise.resolve(null),
    effectiveValue: (name, key) => owner(name)?.effectiveValue(name, key) ?? Promise.resolve(null),
    printerModel: (tag, code) => firstNonNull((p) => p.printerModel(tag, code)),
    modelOf: (pn) => firstNonNull((p) => p.modelOf(pn)),
  };
}

/**
 * A system lookup for resolve.ts that answers with Studio's names (see findByStudioName) for
 * every parent these presets name. Other names fall back to the index names.
 *
 * A preset whose file says "instantiation": "false" (a template such as fdm_process_common, or
 * "Generic PLA @base") is no parent: Studio keeps those only to build system presets from, never
 * in the preset list a user preset's parent is looked up in
 * (src/libslic3r/PresetBundle.cpp:6718-6728@v02.09.01.70). A body that can't be read still
 * counts as present, so a read error never turns an existing parent into a missing one.
 */
export async function studioNameLookup(
  system: SystemIndex,
  presets: readonly { json?: Record<string, unknown> }[],
): Promise<{ get(name: string): SystemEntry | undefined }> {
  const known = new Map<string, SystemEntry | null>();
  for (const p of presets) {
    const inherits = p.json?.['inherits'];
    if (typeof inherits !== 'string' || inherits === '' || known.has(inherits)) continue;
    const entry = await system.findByStudioName(inherits);
    const body = entry ? await system.load(entry.name) : null;
    known.set(inherits, entry && (body === null || body.instantiation) ? entry : null);
  }
  return {
    get: (name) => {
      const hit = known.get(name);
      return hit === undefined ? system.get(name) : (hit ?? undefined);
    },
  };
}
