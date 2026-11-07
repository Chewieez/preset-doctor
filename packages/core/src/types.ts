import type { InfoFile } from './infoFile.js';
import type { JsonFormat } from './jsonFile.js';

export type Severity = 'error' | 'warning' | 'info';

/**
 * The three kinds of user preset, named like the folders Studio keeps them in
 * (PRESET_FILAMENT_NAME, PRESET_PRINT_NAME, PRESET_PRINTER_NAME,
 * src/libslic3r/Preset.hpp:21-23@v02.09.01.70). The UI calls them Filament, Process and Printer.
 */
export const PRESET_TYPES = ['filament', 'process', 'machine'] as const;
export type PresetType = (typeof PRESET_TYPES)[number];

/** Which slicer a data folder belongs to: Bambu Studio or OrcaSlicer (slicer.ts). */
export type SlicerId = 'bambu' | 'orca';

/** Every rule's id, in one place; rules export their own as R1_ID, R4_ID and R5_ID. */
export const RULE_IDS = {
  orphanedParent: 'R1_ORPHANED_PARENT',
  /** R2: loaded, but only for printers that aren't added in the slicer. Report-only. */
  printerNotAdded: 'R2_PRINTER_NOT_ADDED',
  /** R3: loaded, but for a nozzle size of an added printer that isn't added. Report-only. */
  nozzleNotAdded: 'R3_NOZZLE_NOT_ADDED',
  /** R3, grouped: presets for another added printer or process. One scan-level note. */
  notForSelection: 'R3_NOT_FOR_SELECTION',
  malformed: 'R4_MALFORMED',
  cloudSync: 'R5_CLOUD_SYNC',
} as const;

export type RuleId = (typeof RULE_IDS)[keyof typeof RULE_IDS];

/**
 * How the preset looks from inside Bambu Studio. Rank, best to worst:
 * ok < info < unsupported < hidden < broken. 'unsupported' means loaded, but not offered for
 * any printer that is added (R2/R3).
 */
export type PresetStatus = 'ok' | 'hidden' | 'broken' | 'info' | 'unsupported';

export type Confidence = 'high' | 'medium' | 'low';

export interface Candidate {
  /** Preset name to put in `inherits`. */
  name: string;
  confidence: Confidence;
  /** setting_id of the candidate (system presets), used for the sidecar's base_id. */
  settingId?: string;
  /** Plain-English reason shown next to the choice. */
  reason: string;
  preselected: boolean;
  /** Where the candidate lives. Only system candidates update the sidecar's base_id. */
  source?: 'system' | 'user';
  /**
   * The candidate's effective compatible_printers. Set for process candidates: the new parent
   * decides which printers Studio offers the process for.
   */
  printers?: string[];
}

export type ProposedFix =
  { kind: 'setInherits'; candidates: Candidate[] } | { kind: 'renamePreset'; newName: string };

export interface Finding {
  ruleId: RuleId;
  severity: Severity;
  /** Root-relative path of the preset JSON (or of BambuStudio.conf for scan-level findings). */
  presetPath: string;
  presetName?: string;
  /** The preset's type. Absent on scan-level findings (R5, R3_NOT_FOR_SELECTION). */
  presetType?: PresetType;
  status: PresetStatus;
  /** Short headline, e.g. "Parent preset is missing". */
  title: string;
  /** Plain English for non-developers. */
  explanation: string;
  proposedFix?: ProposedFix;
  /** R2/R3: the compatibility verdict the finding explains. */
  compat?: CompatDetail;
}

/** One file edit. Diffs and dry runs are computed from before/after. */
export interface Change {
  path: string;
  before: string;
  after: string;
  description: string;
}

/** A user preset file as read from disk. */
export interface UserPreset {
  /** From the folder the file is in (never from a "type" key, which user presets don't have). */
  type: PresetType;
  /** Account folder name under user/, e.g. '1000000001' or 'default'. */
  accountId: string;
  /** Root-relative path: 'user/<id>/<type>/[base/]<file>.json'. */
  path: string;
  /** File name without '.json'. */
  fileStem: string;
  /**
   * True for presets in <type>/base/: parentless presets (made with the "Create Filament" or
   * "Create Printer" wizard, or detached from their parent).
   */
  isBase: boolean;
  raw: string;
  /** Parsed object; absent when the file is not valid JSON or not an object. */
  json?: Record<string, unknown>;
  parseError?: string;
  format?: JsonFormat;
  /** Root-relative path where the sidecar is (or would be). */
  infoPath: string;
  info?: InfoFile;
  infoRaw?: string;
  /** Why an existing .info sidecar could not be read: the adapter's error message. */
  infoError?: string;
  /** With infoError: the sidecar path is a folder, so scanning again won't help. */
  infoIsFolder?: boolean;
}

/** One row of the results table. Every preset gets one, including healthy ones. */
export interface PresetSummary {
  type: PresetType;
  accountId: string;
  path: string;
  /** File name without '.json' (in any case); what to show when there is no name. */
  fileStem: string;
  name?: string;
  inherits?: string;
  isBase: boolean;
  /** Worst status across this preset's findings; 'ok' when there are none. */
  status: PresetStatus;
  /** One plain-English line for the table, e.g. 'Parent "X" is missing'. */
  reason: string;
  ruleIds: RuleId[];
  /** Compatibility verdict, when R2/R3 ran for this preset (filament and process only). */
  compat?: CompatDetail;
}

export interface AccountSummary {
  id: string;
  /** All types together; the default account is the one with the most. */
  presetCount: number;
  byType: Record<PresetType, number>;
}

export interface ScanResult {
  root: string;
  /** Account that was scanned. */
  userId: string;
  accounts: AccountSummary[];
  presets: PresetSummary[];
  findings: Finding[];
  /** Non-fatal problems, e.g. a system index entry whose file is missing. */
  warnings: string[];
  /** BBL.json "version", e.g. '02.08.00.06'; null if the index could not be read. */
  systemVersion: string | null;
  /**
   * False when a type's system index could not be read (see indexesRead): parents of that type
   * were then not checked at all, so presets with a parent are reported as 'info' ("could not be
   * checked"), never as OK. True only when every type's index was read.
   */
  systemIndexRead: boolean;
  /** The slicer whose folder this is. */
  slicer: SlicerId;
  /** OrcaSlicer: its version from the conf's "header", e.g. '2.3.2-rc'. Bambu Studio: null. */
  slicerVersion: string | null;
  /** Presets of the scanned account, per type. */
  countsByType: Record<PresetType, number>;
  /** Per type: was its system index readable? A vendor without that list counts as read (empty). */
  indexesRead: Record<PresetType, boolean>;
  /** What R2/R3 knew about the printers added in the slicer. */
  compat: CompatContext;
}

/**
 * The compatibility verdict for one loaded filament or process preset (compat.ts):
 * - 'all': no printer list and no condition, so it is offered for every printer;
 * - 'selected': offered for the selected printer;
 * - 'other-printer': offered for another printer that is added (the grouped R3 note);
 * - 'cant-tell': a condition only the slicer can evaluate, or values Preset Doctor can't read;
 * - 'nozzle-not-added': for an added printer, but only with a nozzle size that isn't added (R3);
 * - 'printer-not-added': only for printers that aren't added (R2);
 * - 'unknown-printers': only for printer names no profile defines (R2);
 * - 'other-vendor': the added printers that fit its list use another vendor profile (R2);
 * - 'printer-hidden': for one of the account's own printer presets, which the slicer can't load
 *   now (R1/R4 hide it); repairing that printer brings it back (R2).
 */
export type CompatState =
  | 'all'
  | 'selected'
  | 'other-printer'
  | 'cant-tell'
  | 'nozzle-not-added'
  | 'printer-not-added'
  | 'unknown-printers'
  | 'other-vendor'
  | 'printer-hidden';

/** Where a preset's printer list (compatible_printers) comes from. */
export type CompatSource =
  | { kind: 'own' }
  | { kind: 'inherited'; from: string }
  /** A custom filament's list, taken from its name after "@", as the slicer does at load. */
  | { kind: 'name' }
  /** No preset in the chain sets it. */
  | { kind: 'default' };

export interface CompatDetail {
  state: CompatState;
  /** The effective compatible_printers; [] when there is none. */
  printers: string[];
  source: CompatSource;
  /** Added printers the list names ('other-printer', 'other-vendor'). */
  matchedPrinters?: string[];
  /** List entries that no printer profile defines. */
  unknownNames?: string[];
  /** A printer model or nozzle size was read from a printer's name, not from its profile. */
  guessed?: boolean;
  /** 'nozzle-not-added': the printer model, the sizes the list has for it, and the added ones. */
  model?: string;
  nozzles?: string[];
  addedNozzles?: string[];
  /** 'printer-hidden': the account's own printer presets the list names that can't load now. */
  hiddenPrinters?: string[];
  /** 'other-vendor': the vendor profile the preset is based on. */
  vendor?: string;
  /** Filament against the selected process: only for other processes, or a condition. */
  process?: 'mismatch' | 'cant-tell';
  /** 'cant-tell': why. */
  why?: 'condition' | 'opaque';
}

export interface CompatContext {
  /** False when R2/R3 didn't run; `why` says why. */
  checked: boolean;
  why?: 'no-conf' | 'conf-unreadable' | 'no-printers' | 'system-unreadable';
  /** The selected printer (the conf's presets.machine), when it is a loaded printer. */
  selectedPrinter?: string;
  /** The selected process (presets.process). */
  selectedProcess?: string;
  /** The printer models added in the slicer (the conf's "models"), one entry per model. */
  enabled: { vendor: string; model: string; nozzles: string[] }[];
  /** Number of the account's own printer presets, which always count as added. */
  userPrinters: number;
  /** Whether the slicer lists incompatible presets in an "Unsupported presets" group. */
  unsupportedGroup: 'shown' | 'hidden-by-setting';
}
