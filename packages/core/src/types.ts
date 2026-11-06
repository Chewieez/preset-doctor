import type { InfoFile } from './infoFile.js';
import type { JsonFormat } from './jsonFile.js';

export type Severity = 'error' | 'warning' | 'info';

/** Every rule's id, in one place; rules export their own as R1_ID, R4_ID and R5_ID. */
export const RULE_IDS = {
  orphanedParent: 'R1_ORPHANED_PARENT',
  malformed: 'R4_MALFORMED',
  cloudSync: 'R5_CLOUD_SYNC',
} as const;

export type RuleId = (typeof RULE_IDS)[keyof typeof RULE_IDS];

/** How the preset looks from inside Bambu Studio. */
export type PresetStatus = 'ok' | 'hidden' | 'broken' | 'info';

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
}

export type ProposedFix =
  { kind: 'setInherits'; candidates: Candidate[] } | { kind: 'renamePreset'; newName: string };

export interface Finding {
  ruleId: RuleId;
  severity: Severity;
  /** Root-relative path of the preset JSON (or of BambuStudio.conf for scan-level findings). */
  presetPath: string;
  presetName?: string;
  status: PresetStatus;
  /** Short headline, e.g. "Parent preset is missing". */
  title: string;
  /** Plain English for non-developers. */
  explanation: string;
  proposedFix?: ProposedFix;
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
  /** Account folder name under user/, e.g. '1000000001' or 'default'. */
  accountId: string;
  /** Root-relative path, e.g. 'user/1000000001/filament/Foo.json'. */
  path: string;
  /** File name without '.json'. */
  fileStem: string;
  /** True for presets in filament/base/ (made with the "Create Filament" wizard). */
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
}

export interface AccountSummary {
  id: string;
  presetCount: number;
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
   * False when no system index could be read: parents were then not checked at all, so presets
   * with a parent are reported as 'info' ("could not be checked"), never as OK.
   */
  systemIndexRead: boolean;
}
