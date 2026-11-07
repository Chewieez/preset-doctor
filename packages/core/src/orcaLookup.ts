/**
 * How OrcaSlicer finds a user preset's parent. Its user loader calls find_preset2 with
 * auto_match (src/libslic3r/Preset.cpp:1907-1917@v2.5.0), which tries, in order
 * (src/libslic3r/Preset.cpp:3894-3931@v2.5.0; one rename step only in @v2.3.2:2738-2764):
 *
 *   1. the exact name, among presets Orca lists (instantiable system presets, see
 *      studioNameLookup, and the user's own);
 *   2. the "renamed_from" names of system presets, followed recursively (2.5) or one step
 *      (before 2.5). A preset without renamed_from or alias gets one derived from its name: the
 *      part before the first "@", untrimmed, plus the part after it
 *      (src/libslic3r/PresetBundle.cpp:7934-7943@v2.5.0; map built at
 *      src/libslic3r/Preset.cpp:4466-4479@v2.5.0, first entry wins);
 *   3. only for a name containing "Generic": the name rewritten to "Generic <material> @System",
 *      then steps 1 and 2 again.
 *
 * Steps 2 and 3 arrived in OrcaSlicer 2.3.0 (find_preset2). Up to 2.2 the user loader looks the
 * parent up by its exact name only (find_preset, src/libslic3r/Preset.cpp:1146@v2.2.0), so
 * there step 1 is all; an unknown version gets the 2.5 lookup.
 *
 * Two more ways a parent can exist that Preset Doctor can't look into: a bundle preset of Orca 2.5
 * ("_local/<id>/<name>" or "_subscribed/<id>/<name>", src/libslic3r/Preset.cpp:106-131@v2.5.0,
 * loaded before plain presets, src/libslic3r/PresetBundle.cpp:1445-1520@v2.5.0), and a name in a
 * packed .opc vendor (opc.ts). Both give an `opaque` entry: present, settings unknown.
 */
import { joinPath, type PresetFs } from './fs.js';
import { parseVersion } from './slicer.js';
import type { SystemEntry, SystemIndex, SystemIndexSet } from './systemIndex.js';
import type { PresetType, UserPreset } from './types.js';

export type ParentResolution =
  | { via: 'exact'; entry: SystemEntry }
  /** `chain`: the names from the one asked for to the one found, both included. */
  | { via: 'renamed'; entry: SystemEntry; chain: string[] }
  | { via: 'generic'; entry: SystemEntry; rewritten: string }
  | { via: 'opc'; entry: SystemEntry }
  | { via: 'bundle'; entry: SystemEntry; path: string };

export interface OrcaLookup {
  /** The entry Orca would use as the parent, as resolve.ts asks for it. */
  get(name: string): SystemEntry | undefined;
  /** How a parent name these presets use was found; undefined when it wasn't. */
  resolution(name: string): ParentResolution | undefined;
  /**
   * True when .opc vendors exist: a name that isn't found may still be in one of them (an
   * unreadable file, or a derived old name, which the cache doesn't store), so it can't be called
   * missing.
   */
  unchecked: boolean;
  /** The vendors that are installed (system/<V>.json or .opc). */
  vendors: readonly string[];
}

/** find_preset2's rewrite (src/libslic3r/Preset.cpp:3919-3921@v2.5.0). */
const GENERIC_RE = /^(?:.*?\b(?:\w+_)?)(Generic)\b\s+([^@]+?)\s*(?:@.*)?$/;

/** "Generic PLA @Elegoo CC" -> "Generic PLA @System"; the name itself when it doesn't match. */
export function genericFallbackName(name: string): string {
  return name.replace(GENERIC_RE, 'Generic $2 @System');
}

/** The old name Orca derives for a system preset that states none (see the module comment). */
export function derivedRenamedFrom(name: string): string | undefined {
  const at = name.indexOf('@');
  return at < 0 ? undefined : name.slice(0, at) + name.slice(at + 1);
}

const BUNDLE_RE = /^(_local|_subscribed)\/([^/\\]+)\/(.+)$/;

/**
 * The parent lookup for one preset type of one account, answering every parent name these
 * presets use. A name that is the file name of one of `presets` is the user's own preset, which
 * Orca finds by its exact name before any fallback.
 */
export async function orcaParentLookup(args: {
  system: SystemIndex;
  set: SystemIndexSet;
  fs: PresetFs;
  accountId: string;
  type: PresetType;
  presets: readonly UserPreset[];
  /** The OrcaSlicer version (no fallbacks before 2.3, renames one step before 2.5). */
  version: string | null;
}): Promise<OrcaLookup> {
  const { system, set, fs, accountId, type, presets } = args;
  const userNames = new Set(presets.map((p) => p.fileStem));
  const v = parseVersion(args.version);
  const recursive = v === null || v.major > 2 || (v.major === 2 && v.minor >= 5);
  const fallbacks = v === null || v.major > 2 || (v.major === 2 && v.minor >= 3);

  const exactCache = new Map<string, Promise<SystemEntry | null>>();
  const exact = (name: string): Promise<SystemEntry | null> => {
    let p = exactCache.get(name);
    if (!p) {
      p = (async () => {
        const entry = await system.findByStudioName(name);
        if (!entry) return null;
        const body = await system.load(entry.name);
        // A template ("instantiation": "false") is not in the list Orca searches.
        return body === null || body.instantiation ? entry : null;
      })();
      exactCache.set(name, p);
    }
    return p;
  };

  let renames: Promise<Map<string, string>> | undefined;
  const renameMap = (): Promise<Map<string, string>> =>
    (renames ??= (async () => {
      const map = new Map<string, string>();
      for (const body of await system.loadAll()) {
        if (!body.instantiation) continue;
        const derived = body.alias === undefined ? derivedRenamedFrom(body.studioName) : undefined;
        const olds = body.renamedFrom ?? (derived !== undefined ? [derived] : []);
        for (const old of olds) if (!map.has(old)) map.set(old, body.studioName);
      }
      return map;
    })());

  /** Steps 1 and 2 (find_preset). */
  const findPreset = async (
    name: string,
  ): Promise<Extract<ParentResolution, { via: 'exact' | 'renamed' }> | undefined> => {
    const hit = await exact(name);
    if (hit) return { via: 'exact', entry: hit };
    if (!fallbacks) return undefined;
    const map = await renameMap();
    const chain = [name];
    let current = name;
    for (;;) {
      const next = map.get(current);
      if (next === undefined || chain.includes(next)) return undefined;
      chain.push(next);
      const found = await exact(next);
      if (found) return { via: 'renamed', entry: found, chain };
      if (!recursive) return undefined;
      current = next;
    }
  };

  const opaqueEntry = (name: string, path: string, vendor: string): SystemEntry => ({
    name,
    subPath: '',
    path,
    vendor,
    opaque: true,
  });

  const resolve = async (name: string): Promise<ParentResolution | undefined> => {
    const direct = await findPreset(name);
    if (direct) return direct;
    const bundle = BUNDLE_RE.exec(name);
    if (bundle) {
      const [, kind, id, bare] = bundle as unknown as [string, string, string, string];
      for (const sub of [type, `${type}/base`]) {
        const path = joinPath('user', accountId, kind, id, sub, `${bare}.json`);
        if (await fs.exists(path).catch(() => false)) {
          return { via: 'bundle', entry: opaqueEntry(name, path, kind), path };
        }
      }
    }
    const opc = set.opaque.find((o) => o.readable);
    if (opc && set.opcHas(name))
      return { via: 'opc', entry: opaqueEntry(name, opc.path, opc.vendor) };
    if (fallbacks && name.includes('Generic')) {
      const rewritten = genericFallbackName(name);
      if (rewritten !== name) {
        const found = await findPreset(rewritten);
        if (found) return { via: 'generic', entry: found.entry, rewritten };
        if (opc && set.opcHas(rewritten)) {
          return { via: 'opc', entry: opaqueEntry(rewritten, opc.path, opc.vendor) };
        }
      }
    }
    return undefined;
  };

  const known = new Map<string, ParentResolution | null>();
  for (const p of presets) {
    const inherits = p.json?.['inherits'];
    if (typeof inherits !== 'string' || inherits === '' || known.has(inherits)) continue;
    // The user's own preset of that name is found first, as Orca searches one list.
    if (userNames.has(inherits) && !(await exact(inherits))) continue;
    known.set(inherits, (await resolve(inherits)) ?? null);
  }

  return {
    get: (name) => {
      const hit = known.get(name);
      if (hit === undefined) return system.get(name);
      if (hit === null) return undefined;
      // Found under another name: say which, for texts ("inherited from ...").
      return hit.via === 'renamed' || hit.via === 'generic'
        ? { ...hit.entry, currentName: hit.entry.name }
        : hit.entry;
    },
    resolution: (name) => known.get(name) ?? undefined,
    // A vendor whose index failed to load may still hold the parent (Orca may even load it from
    // its .opc cache), so a name that isn't found can't be called missing either.
    unchecked: set.opaque.length > 0 || (set.failedVendors[type]?.length ?? 0) > 0,
    vendors: set.vendors,
  };
}
