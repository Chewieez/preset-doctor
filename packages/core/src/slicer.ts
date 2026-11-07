/**
 * Everything that differs between slicers lives in a SlicerProfile, so the rules stay
 * slicer-neutral: Bambu Studio (BAMBU, exactly the choices that used to be hard-coded) and
 * OrcaSlicer (ORCA). docs/design-v0.2.md sections 3 and 6 have the details and the citations.
 */
import type { SlicerConf } from './conf.js';
import { joinPath, type DirEntry, type PresetFs } from './fs.js';
import type { SlicerId } from './types.js';

export interface VendorPlan {
  /** Names of system/<V>.json files, in load order (the first one wins on a duplicate name). */
  json: string[];
  /** Names of system/<V>.opc files with no matching system/<V>.json (OrcaSlicer only). */
  opc: string[];
  /** Vendor whose index must load, or the scan reports the system presets as unreadable. */
  required?: string;
  /** A vendor whose presets any vendor's system presets may inherit (OrcaSlicer only). */
  base?: string;
}

export interface SlicerProfile {
  id: SlicerId;
  displayName: 'Bambu Studio' | 'OrcaSlicer';
  /** Short name in running text: 'Studio' | 'Orca'. */
  shortName: string;
  /** Folder name under %APPDATA%. */
  rootDirName: string;
  /** Root-relative path of the app config. */
  confFile: string;
  /** Process names, compared case-insensitively, with or without .exe. */
  processNames: readonly string[];
  /** Vendor indexes to load, given the listing of system/ ([] when it can't be listed). */
  vendorOrder(systemListing: readonly DirEntry[]): VendorPlan;
  /** How a parent name is looked up. */
  parentLookup: 'exact' | 'orca';
  /** Studio checks the vendor in is_compatible_with_printer; OrcaSlicer does not. */
  vendorCheck: boolean;
  /** Whether incompatible presets are shown in an "Unsupported presets" group. */
  unsupportedGroup(conf: SlicerConf): 'shown' | 'hidden-by-setting';
  /** OrcaSlicer 2.5: a lone .info with a setting_id means "delete in the cloud". */
  loneInfoIsCloudDelete: boolean;
  /** R5 wording. */
  cloudSyncText(conf: SlicerConf): { title: string; explanation: string };
  /** The slicer's version from its conf (OrcaSlicer: the "header"); null when unknown. */
  versionFrom(conf: SlicerConf): string | null;
  /**
   * The rules' texts are written for Bambu Studio; this rewords one for this slicer. Quoted
   * parts (preset names) are never changed. Bambu Studio: the text as it is.
   */
  reword(text: string): string;
}

export const CLOUD_SYNC_EXPLANATION =
  "Turning it off shouldn't be needed: the cloud copy of a hidden preset names the same missing " +
  'parent, so Studio skips it instead of putting the old version back. The repair usually ' +
  "isn't uploaded on its own, though (Studio uploads it by itself only if the preset was never " +
  'synced or still had changes waiting to sync). To get it onto your other computers, open ' +
  'each repaired preset in Bambu Studio and save it.';

const BBL = 'BBL';

export const BAMBU: SlicerProfile = {
  id: 'bambu',
  displayName: 'Bambu Studio',
  shortName: 'Studio',
  rootDirName: 'BambuStudio',
  confFile: 'BambuStudio.conf',
  processNames: ['bambu-studio', 'BambuStudio'],
  /**
   * system/BBL.json first, then each other system/<Vendor>.json that has a matching
   * system/<Vendor>/ folder (Studio copies a vendor there once one of its printers is enabled,
   * e.g. Creality or Prusa).
   */
  vendorOrder(listing) {
    const dirs = new Set(listing.filter((e) => e.kind === 'dir').map((e) => e.name.toLowerCase()));
    const others = listing
      .filter((e) => e.kind === 'file' && e.name.toLowerCase().endsWith('.json'))
      .map((e) => e.name.slice(0, -'.json'.length))
      .filter((v) => v.toLowerCase() !== BBL.toLowerCase() && dirs.has(v.toLowerCase()));
    return { json: [BBL, ...others], opc: [], required: BBL };
  },
  parentLookup: 'exact',
  vendorCheck: true,
  unsupportedGroup: () => 'shown',
  loneInfoIsCloudDelete: false,
  cloudSyncText: () => ({ title: 'Cloud preset sync is on', explanation: CLOUD_SYNC_EXPLANATION }),
  versionFrom: () => null,
  reword: (text) => text,
};

/** OrcaSlicer's shared filament library: every other vendor loads on top of it. */
export const ORCA_LIBRARY = 'OrcaFilamentLibrary';

/**
 * OrcaSlicer (docs/design-v0.2.md section 6). Its data folder has the same layout as Studio's.
 * The differences: every system/<V>.json is a vendor, the filament library first
 * (src/libslic3r/PresetBundle.cpp:3338-3341, 3361-3372@v2.5.0); parents are also found under
 * their old names and through the "Generic" fallback (src/libslic3r/Preset.cpp:3894-3931@v2.5.0,
 * orcaLookup.ts); no vendor check in the compatibility test
 * (src/libslic3r/Preset.cpp:904-907@v2.5.0); and from 2.4 on the "Unsupported presets" group is
 * hidden unless a developer setting is on (src/slic3r/GUI/PresetComboBoxes.cpp:1505-1507@v2.5.0).
 */
export const ORCA: SlicerProfile = {
  id: 'orca',
  displayName: 'OrcaSlicer',
  shortName: 'Orca',
  rootDirName: 'OrcaSlicer',
  confFile: 'OrcaSlicer.conf',
  // "orca-slicer" is the real exe (src/CMakeLists.txt:223-229@v2.5.0); the second one is
  // defensive: a false positive only refuses a write.
  processNames: ['orca-slicer', 'OrcaSlicer'],
  vendorOrder(listing) {
    const files = listing.filter((e) => e.kind === 'file');
    const stems = (ext: string): string[] =>
      files
        .filter((e) => e.name.toLowerCase().endsWith(ext))
        .map((e) => e.name.slice(0, -ext.length))
        .filter((v) => v !== '');
    const json = stems('.json');
    const lower = new Set(json.map((v) => v.toLowerCase()));
    const library = json.find((v) => v.toLowerCase() === ORCA_LIBRARY.toLowerCase());
    const others = json
      .filter((v) => v !== library)
      .sort((a, b) => compareText(a.toLowerCase(), b.toLowerCase()));
    const plan: VendorPlan = {
      json: library === undefined ? others : [library, ...others],
      opc: stems('.opc').filter((v) => !lower.has(v.toLowerCase())),
    };
    if (library !== undefined) plan.base = library;
    return plan;
  },
  parentLookup: 'orca',
  vendorCheck: false,
  unsupportedGroup(conf) {
    if (conf.showUnsupportedPresets === true) return 'shown';
    // Up to 2.3 the group is always shown (src/slic3r/GUI/PresetComboBoxes.cpp:1356@v2.3.2). An
    // unknown version gets the safer "may not appear" wording.
    const v = parseVersion(ORCA.versionFrom(conf));
    return v !== null && (v.major < 2 || (v.major === 2 && v.minor < 4))
      ? 'shown'
      : 'hidden-by-setting';
  },
  loneInfoIsCloudDelete: true,
  cloudSyncText(conf) {
    const clouds = cloudNames(conf.cloudProviders ?? []);
    const explanation = ORCA.reword(CLOUD_SYNC_EXPLANATION);
    return {
      title: 'Cloud preset sync is on',
      explanation:
        clouds === ''
          ? explanation
          : `OrcaSlicer syncs your presets with ${clouds}. ${explanation}`,
    };
  },
  versionFrom(conf) {
    const h = conf.header?.trim();
    if (h === undefined || h === '') return null;
    return h.replace(/^OrcaSlicer\s+/i, '');
  },
  reword: (text) => rewordOutsideQuotes(text, ORCA_WORDS),
};

/** Bambu Studio wording to OrcaSlicer wording, in this order. */
const ORCA_WORDS: readonly (readonly [RegExp, string])[] = [
  [/\bBambu Studio\b/g, 'OrcaSlicer'],
  [/\bBambu's current\b/g, "OrcaSlicer's current"],
  [/\bBambu now uses\b/g, 'OrcaSlicer now uses'],
  [/\bStudio\b/g, 'OrcaSlicer'],
];

/** Applies the replacements everywhere except inside "double-quoted" parts. */
function rewordOutsideQuotes(text: string, words: readonly (readonly [RegExp, string])[]): string {
  return text
    .split(/("[^"]*")/)
    .map((part, i) => (i % 2 === 1 ? part : words.reduce((t, [re, to]) => t.replace(re, to), part)))
    .join('');
}

function cloudNames(providers: readonly string[]): string {
  const names: string[] = [];
  if (providers.includes('orca')) names.push('Orca Cloud');
  if (providers.includes('bbl')) names.push('the Bambu cloud');
  return names.join(' and ');
}

/** "2.3.2-rc" -> { major: 2, minor: 3 }; null when it doesn't start with two numbers. */
export function parseVersion(v: string | null): { major: number; minor: number } | null {
  const m = v === null ? null : /^(\d+)\.(\d+)/.exec(v);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const SLICERS: readonly SlicerProfile[] = [BAMBU, ORCA];

export function slicerById(id: SlicerId): SlicerProfile {
  return id === 'orca' ? ORCA : BAMBU;
}

/** "a Bambu Studio folder", "an OrcaSlicer folder". */
export function slicerFolder(id: SlicerId): string {
  const name = slicerById(id).displayName;
  return `${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name} folder`;
}

export type SlicerDetection =
  | { ok: true; profile: SlicerProfile; evidence: string }
  | { ok: false; reason: 'both' | 'neither'; message: string };

/**
 * Which slicer the folder belongs to, from its files (docs/design-v0.2.md section 6.1). The first
 * rule that matches wins. OrcaSlicer's library is checked before system/BBL.json, because Orca
 * also installs BBL.json when Bambu printers are enabled in it. A folder with only user/ is read
 * as a Bambu Studio folder, as before OrcaSlicer was supported.
 */
export async function detectSlicer(fs: PresetFs): Promise<SlicerDetection> {
  const has = async (path: string): Promise<boolean> => {
    try {
      return await fs.exists(path);
    } catch {
      return false;
    }
  };
  const found = (profile: SlicerProfile, evidence: string): SlicerDetection => ({
    ok: true,
    profile,
    evidence,
  });
  const [bambuConf, orcaConf] = await Promise.all([has(BAMBU.confFile), has(ORCA.confFile)]);
  if (bambuConf && orcaConf) {
    return {
      ok: false,
      reason: 'both',
      message:
        "This folder holds files from both Bambu Studio and OrcaSlicer. Pick the slicer's own folder.",
    };
  }
  if (orcaConf) return found(ORCA, `${ORCA.confFile} is there.`);
  if (bambuConf) return found(BAMBU, `${BAMBU.confFile} is there.`);
  for (const ext of ['.json', '.opc']) {
    const library = joinPath('system', `${ORCA_LIBRARY}${ext}`);
    if (await has(library)) return found(ORCA, `${library} is there.`);
  }
  if (await has('system/BBL.json')) return found(BAMBU, 'system/BBL.json is there.');
  if (await has('user')) {
    return found(BAMBU, 'Only a user folder is there; that is read as a Bambu Studio folder.');
  }
  return {
    ok: false,
    reason: 'neither',
    message:
      "doesn't look like a Bambu Studio or OrcaSlicer data folder: there is no BambuStudio.conf or " +
      'OrcaSlicer.conf, no system preset index (system/BBL.json or system/OrcaFilamentLibrary.json) ' +
      'and no user folder.',
  };
}
