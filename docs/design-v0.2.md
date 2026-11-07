# Preset Doctor v0.2 design: process and printer presets, the "Unsupported" helper, OrcaSlicer

Status: **contract for the three v0.2 implementers** (Nov 7, 2026). Steps 1 and 2 are built;
where they differ from the text below, §4.11 and §5.9 say how and why. Step 3 is not built yet.
Three people (or agents) implement it one after another, in this order:

1. **Step 1, preset types.** Process and printer (machine) presets, plus the slicer seam with Bambu Studio only.
2. **Step 2, R2/R3.** The report-only "Unsupported" helper.
3. **Step 3, OrcaSlicer.** The second slicer profile, plus slicer-aware backups, the desktop picker, the web guide and the rebrand.

Each step must leave `npm test`, lint and typecheck green, and must leave the app shippable.
When this document and the code disagree, the code wins only where this document says
"implementer's choice". Anything else is a bug in one of the two, and the fix is to update this
document.

How citations are written:

- Bambu Studio citations are `path:line@v02.09.01.70` (commit `56a57d00`), with paths relative to
  `src/` of bambulab/BambuStudio.
- OrcaSlicer citations are `path:line@v2.5.0` (commit `40ecc66f7`, the latest stable tag on
  Nov 7, 2026) or `@v2.3.2`, with paths relative to `src/` of SoftFever/OrcaSlicer.
- `libslic3r/...` and `slic3r/GUI/...` are the two source trees.

Live-data facts come from read-only analysis of a real `%APPDATA%\BambuStudio` and
`%APPDATA%\OrcaSlicer`. Accounts are called A (main) and B.

---

## 0. Decisions at a glance

| # | Decision |
|---|---|
| D1 | `PresetType = 'filament' \| 'process' \| 'machine'`. The ids are the folder names Studio and Orca use. The UI calls them **Filament / Process / Printer**. |
| D2 | One scan reads **all three types**. Rules run per type, and parents only resolve within the same type. |
| D3 | A preset's type comes from its **folder**, never from a `type` key. None of the 227 live user presets has one. |
| D4 | R1 and R4 apply to every type. The candidate ranking is type-specific: filament ranking is unchanged, process ranking is §4.5, machine ranking is §4.6. **Printer candidates are never pre-selected.** |
| D5 | R2/R3 are **report-only**, severity `info`. New status `'unsupported'`. They apply to filament and process presets, never to printer presets. "Another printer you have added" (R3b) is **one grouped note**, not one row per preset. |
| D6 | A `SlicerProfile` object holds everything slicer-specific. Step 1 adds the seam with `BAMBU` only. **For Bambu Studio, the scan output stays identical** (see §2.3 for what "identical" means). Step 3 adds `ORCA`. |
| D7 | The slicer is **detected from the folder** on every scan. No API takes a slicer argument except the CLI's `--slicer`, which only picks the default folder and checks the detection. |
| D8 | OrcaSlicer 2.5 binary system caches (`system/*.opc`) are read with a **string-presence test only**. If a parent is found, the preset is OK. If not, the preset is "could not be checked" (`info`), never "hidden", and no fix is offered. |
| D9 | Backups gain a `slicer` field. A restore into the other slicer's folder is **refused, with no override**. Restores write `X.json` before `X.info`. For Orca, a restore never creates a lone `.info` (§6.8). |
| D10 | Safety (SPEC §6) is unchanged for every type and every slicer. The full list is in §1. |

---

## 1. Invariants (all steps, all types, both slicers)

Every one of these must still hold, and each has a test:

1. **No writes while the slicer is running.** The desktop app checks the process of the slicer
   whose folder it is writing (§6.6). The web version keeps its required checkbox, with the
   slicer's name in the label.
2. **Back up before the first write.** The whole `user/` folder is zipped, and the backup is
   checked to cover every planned path (`assertBackupCovers`). This covers `process/`,
   `machine/`, Orca's `_local/` and `_subscribed/`, and every `base/` folder.
3. **Show a diff and wait for an explicit click.**
4. **Minimal byte edits.** Only `setJsonStringField` and `setJsonArrayStringItem` are used, never
   a full re-serialize. Studio and Orca preset files use 4-space indents, and the bytes are kept
   exactly.
5. **Writes go through a temp file, then a rename, then a read-back** (web: write, then verify).
   Both slicers **delete** a user preset whose JSON they can't parse, together with its
   `.info` (`libslic3r/Preset.cpp:1480-1489@v02.09.01.70`;
   `libslic3r/Preset.cpp:154-170, 1885-1889@v2.5.0`).
6. **Fixes never remove keys.** `version` must survive: Studio silently drops a preset without it
   (`libslic3r/Preset.cpp:1491-1492@v02.09.01.70`), and Orca drops it too
   (`libslic3r/Preset.cpp:1893-1897@v2.5.0`).
7. **Never touch `sync_info` or `updated_time`.** Never set `base_id` equal to `setting_id`.
8. **Never create, delete or rename a file.** Edits only. A `.info` never ends up without its
   `.json`. In Orca 2.5 that pairing is load-bearing: a lone `.info` with a `setting_id` queues a
   **cloud delete** (`slic3r/Utils/CloudDeleteQueue.cpp:128-168@v2.5.0`).
9. **No network calls.** Nothing is read from Program Files, from `orca_refresh_token.sec`,
   from `.orcaslicer_machine_id` or from `printers/`.
10. **R2/R3 never offer a fix.** Editing `compatible_printers` would fight Studio's
    "save only what differs from the parent" model (`libslic3r/Preset.cpp:685-722@v02.09.01.70`).

---

## 2. Shared contracts

### 2.1 `packages/core/src/types.ts`

Fields marked (S1), (S2) or (S3) are added in that step. Everything not listed stays as it is.

```ts
export const PRESET_TYPES = ['filament', 'process', 'machine'] as const;   // (S1)
export type PresetType = (typeof PRESET_TYPES)[number];                     // (S1)

export type SlicerId = 'bambu' | 'orca';                                    // (S1, only 'bambu' produced)

export const RULE_IDS = {
  orphanedParent: 'R1_ORPHANED_PARENT',
  printerNotAdded: 'R2_PRINTER_NOT_ADDED',      // (S2)
  nozzleNotAdded: 'R3_NOZZLE_NOT_ADDED',        // (S2)
  notForSelection: 'R3_NOT_FOR_SELECTION',      // (S2) scan-level grouped note
  malformed: 'R4_MALFORMED',
  cloudSync: 'R5_CLOUD_SYNC',
} as const;

/** Rank order (worst last): ok < info < unsupported < hidden < broken. */
export type PresetStatus = 'ok' | 'info' | 'unsupported' | 'hidden' | 'broken';   // 'unsupported' (S2)

export interface Candidate {
  name: string;
  confidence: Confidence;
  settingId?: string;
  reason: string;
  preselected: boolean;
  source?: 'system' | 'user';
  /**
   * (S1) The candidate's effective compatible_printers. Set for process candidates, and for
   * filament candidates where R1 already resolved it. The UI lists it, and planFixes cites it
   * for processes.
   */
  printers?: string[];
}

export interface Finding {
  ruleId: RuleId;
  severity: Severity;
  presetPath: string;
  presetName?: string;
  /** (S1) Absent on scan-level findings (R5, R3_NOT_FOR_SELECTION). */
  presetType?: PresetType;
  status: PresetStatus;
  title: string;
  explanation: string;
  proposedFix?: ProposedFix;
  /** (S2) R2/R3 details, for the detail panel. */
  compat?: CompatDetail;
}

export interface UserPreset {
  type: PresetType;                 // (S1)
  accountId: string;
  path: string;                     // 'user/<id>/<type>/[base/]<file>.json'
  fileStem: string;
  /** True for presets in <type>/base/: parentless presets (wizard, detached). */
  isBase: boolean;
  // ... unchanged ...
}

export interface PresetSummary {
  type: PresetType;                 // (S1)
  // ... unchanged ...
  /** (S2) Compatibility verdict, when R2/R3 ran for this preset (filament and process only). */
  compat?: CompatDetail;
}

export interface AccountSummary {
  id: string;
  /** All types together; used for the default pick (most presets first, as today). */
  presetCount: number;
  byType: Record<PresetType, number>;       // (S1)
}

export interface ScanResult {
  // ... every existing field unchanged ...
  slicer: SlicerId;                          // (S1) always 'bambu' until S3
  /** (S3) Orca: from the conf "header" ("2.3.2-rc"). Bambu: null. */
  slicerVersion: string | null;
  countsByType: Record<PresetType, number>;  // (S1)
  /** (S1) Per type: was its system index readable? A missing list counts as read (empty). */
  indexesRead: Record<PresetType, boolean>;
  /**
   * Existing field. Its meaning widens to "every type's index was read". On every existing
   * fixture it is still true.
   */
  systemIndexRead: boolean;
  /** (S2) What R2/R3 knew about the printers. Always present from S2 on. */
  compat: CompatContext;
}
```

`CompatDetail` and `CompatContext` are defined in §5.6.

### 2.2 Wording per type: `packages/core/src/terms.ts` (new, step 1)

All type-dependent user-facing text goes through this file, and the UI keeps its own copy (it
imports only types from core). The **filament strings are exactly today's strings.**

```ts
export const TERMS: Record<PresetType, {
  noun: string;          // 'filament preset' | 'process preset' | 'printer preset'
  tab: string;           // 'Filament' | 'Process' | 'Printer'
  list: string;          // 'filament list' | 'process list' | 'printer list'
  baseTag: string;       // 'custom filament' | 'custom process' | 'custom printer'
  rootReason: string;    // 'Custom filament, not based on another preset' | 'Custom process, ...' | 'Custom printer, ...'
  settingsIdKey: { key: 'filament_settings_id'; shape: 'array0' } |
                 { key: 'print_settings_id'; shape: 'string' } |
                 { key: 'printer_settings_id'; shape: 'string' };
}>;
```

The settings-id keys come from `libslic3r/Preset.cpp:2697-2703, 2748-2754@v02.09.01.70`.
Process and printer presets store a plain string. Filament presets store an array.

Slicer names in text ("Bambu Studio", "Studio", "OrcaSlicer", "Orca") come from
`SlicerProfile.displayName` and `shortName` (§3).

### 2.3 What "identical for Bambu Studio" means

This applies to the step 1 refactor and to every later step. Take any folder that has **only
filament presets** and a conf whose only setting is `app.sync_user_preset`, which describes
every existing fixture. Scanning it gives:

- the same `presets[]` entries, with the same `status`, `reason`, `name`, `inherits` and `isBase`;
- the same `findings[]`, with the same ids, texts, candidates and pre-selections;
- the same `warnings[]`, `systemVersion` and default account;
- byte-identical CLI text output and the same exit codes.

The scan result may **add** fields: `type`, `presetType`, `byType`, `countsByType`,
`indexesRead`, `slicer`, `slicerVersion`, `compat`, `printers` on candidates, and
`compat: { checked: false, ... }`. Existing tests that compare whole objects must be updated
only by adding those fields. If any existing assertion has to change in another way, the step
broke this rule.

The only intended Bambu change in v0.2 is that `presetCount` counts every type. On a real
folder this can, in theory, change the default account. No fixture is affected.

---

## 3. The slicer seam: `packages/core/src/slicer.ts` (new)

Step 1 creates this file with `BAMBU` and moves today's hard-coded Bambu choices into it. Step 3
adds `ORCA`.

```ts
export interface SlicerProfile {
  id: SlicerId;
  displayName: 'Bambu Studio' | 'OrcaSlicer';
  /** Short name in running text: 'Studio' | 'Orca'. */
  shortName: string;
  /** Folder name under %APPDATA%: 'BambuStudio' | 'OrcaSlicer'. */
  rootDirName: string;
  /** Root-relative conf path: 'BambuStudio.conf' | 'OrcaSlicer.conf'. */
  confFile: string;
  /** Compared case-insensitively, with or without .exe. */
  processNames: readonly string[];
  /** Vendor indexes to load, in priority order (first one wins on a duplicate name). */
  vendorOrder(systemListing: readonly FsEntry[]): VendorPlan;
  /** How a parent name is looked up (§4.3, §6.4). */
  parentLookup: 'exact' | 'orca';
  /** Studio's vendor check in is_compatible_with_printer (§5.3, step 4). Orca: false. */
  vendorCheck: boolean;
  /** Whether incompatible presets are shown in an "Unsupported presets" group (§5.5). */
  unsupportedGroup(conf: SlicerConf): 'shown' | 'hidden-by-setting';
  /** Orca 2.5: a lone .info with a setting_id means "delete in the cloud" (§6.8). */
  loneInfoIsCloudDelete: boolean;
  /** R5 wording; Bambu's is today's CLOUD_SYNC_EXPLANATION, byte for byte. */
  cloudSyncText(conf: SlicerConf): { title: string; explanation: string };
}

export interface VendorPlan {
  /** Names of system/<V>.json files, in load order. */
  json: string[];
  /** (S3) Names of system/<V>.opc files with no matching system/<V>.json. */
  opc: string[];
  /** Vendor whose index must load, or the scan fails (Bambu: 'BBL'; Orca: none). */
  required?: string;
  /**
   * (S3) A vendor whose presets any vendor's system presets may inherit
   * (Orca: 'OrcaFilamentLibrary').
   */
  base?: string;
}

export const BAMBU: SlicerProfile;   // step 1
export const ORCA: SlicerProfile;    // step 3
export const SLICERS: readonly SlicerProfile[];

/** Step 1: always BAMBU. Step 3: the rules in §6.1. */
export async function detectSlicer(fs: PresetFs): Promise<SlicerDetection>;
export type SlicerDetection =
  | { ok: true; profile: SlicerProfile; evidence: string }
  | { ok: false; reason: 'both' | 'neither'; message: string };
```

What `BAMBU` holds (all of it is today's behavior):

- `rootDirName` is `'BambuStudio'` and `confFile` is `'BambuStudio.conf'`.
- `processNames` is today's `STUDIO_PROCESS_NAMES`.
- `vendorOrder` is today's `otherVendors` rule: `BBL` is required and comes first, then every
  other `system/<V>.json` that has a `system/<V>/` folder.
- `parentLookup` is `'exact'` and `vendorCheck` is `true`.
- `unsupportedGroup` always returns `'shown'`, and `loneInfoIsCloudDelete` is `false`.

`scan(fs, options)` calls `detectSlicer` first, then passes the profile into everything below it.
Step 1 leaves `STUDIO_CONF_PATH`, `readStudioConf`, `loadSystemIndexes` and
`isStudioRunning` exported, with their current behavior, as Bambu wrappers. Tests import them.

---

## 4. Feature 1: process and printer presets (step 1)

### 4.1 Where the files are

Both slicers use the same layout (`libslic3r/Preset.hpp:21-23@v02.09.01.70`;
`libslic3r/PresetBundle.cpp:917, 924, 931@v02.09.01.70`):

```
user/<id>/filament/*.json (+ .info)      user/<id>/filament/base/*.json
user/<id>/process/*.json  (+ .info)      user/<id>/process/base/*.json
user/<id>/machine/*.json  (+ .info)      user/<id>/machine/base/*.json
```

What the loader does is the same for every type (`libslic3r/Preset.cpp@v02.09.01.70`):

- `base/` loads first (`:1425-1427`).
- A preset is named by its file (`:1455`).
- A name that is already loaded is skipped (`:1459`).
- If the JSON can't be parsed, Studio deletes the files (`:1480-1489`).
- A missing `version` means the preset is skipped (`:1491-1492`).
- The parent is looked up by exact name (`:1516`). If it isn't found, the preset is skipped
  (`:1528-1531`).
- Top-level presets are only added after the pass ends (`:1598`).

A parent always has the same type as its child, because each collection only resolves within
itself.

Live data has 13 process presets: 10 in account A, 3 in account B. None has a `type` or a
`compatible_printers` key, and all have a `.info` whose `base_id` equals the parent's
`setting_id`. There are no printer presets and no `base/` folders. So the real failures in v0.2
are R2/R3 on processes, and the R1 process and machine tiers are mostly insurance. Across 88
Studio tags, no selectable process or machine preset was ever removed or renamed (§4.5 has the
history).

### 4.2 `userScan.ts`

- `PRESET_DIRS` replaces `FILAMENT_DIRS`, in this order: `filament`, `filament/base`, `process`,
  `process/base`, `machine`, `machine/base`. Each entry carries its `type`. For a filament-only
  folder the order is today's order.
- `scanUser(fs, accountId)` keeps its signature and returns every type.
- `listAccounts` fills `byType`. `presetCount` is the sum.
- `assertAccountId` already accepts non-numeric ids. Keep that, because Orca 2.5 account ids are
  opaque strings (§6.5).

### 4.3 System indexes, one per type: `systemIndex.ts`

```ts
export const LIST_KEY: Record<PresetType, string> =
  { filament: 'filament_list', process: 'process_list', machine: 'machine_list' };

export interface SystemIndexSet {
  byType: Record<PresetType, SystemIndex | null>;   // null: unreadable (a warning says why)
  /** Version of the first vendor in load order (BBL for Bambu); what systemVersion shows. */
  version: string | null;
  readonly warnings: string[];
  /** (S3) Vendors present only as .opc (§6.3). */
  opaque: OpaqueVendor[];
}
export async function loadSystemIndexSet(fs: PresetFs, profile: SlicerProfile): Promise<SystemIndexSet>;
```

Rules:

- **Filament.** The filament index loads exactly as today, so its errors and warnings are
  unchanged.
- **Process and machine.** A missing list key gives an empty index, silently.
  - Live `BBL.json` has both keys. Fixture `BBL.json` files have `[]`.
  - If files are missing, or the index can't be read, it is a `SystemIndexError`. That error
    becomes one warning, `"<msg> Process presets based on system presets can't be checked."`,
    and sets `indexesRead.process = false`.
- **`SystemEntry` gains `vendor: string`.** This is the vendor id of the index that lists the
  entry, for example `'BBL'`.
- **`SystemPreset` gains these fields**, each set only when the file sets it:

  ```ts
  fileType?: string;                     // the file's "type" ('filament' | 'process' | 'machine'); templates have none
  compatiblePrintersCondition?: string;
  compatiblePrints?: string[];
  compatiblePrintsCondition?: string;
  printerModel?: string;                 // machine
  printerVariant?: string;               // machine, e.g. '0.4'
  renamedFrom?: string[];                // (S3) Orca
  ```

- **`effectiveValue`** is a generic walk added to `SystemIndex`.
  `effectiveCompatiblePrinters` becomes a wrapper around it with unchanged results.

  ```ts
  effectiveValue<K extends 'compatiblePrinters' | 'compatiblePrintersCondition' | 'compatiblePrints'
    | 'compatiblePrintsCondition' | 'printerModel' | 'printerVariant'>(name: string, key: K):
    Promise<SystemPreset[K] | null>;
  ```

- **Machine entries.** `machine_list` contains 89 g-code template files that have no `type` and
  no `inherits`, and three `*_common` templates. They must load without a warning. Only presets
  with `fileType === 'machine'` and `instantiation` set are printer candidates or enabled
  printers. `machine_model_list` is ignored.
- **`modelOf`, `printerModel` and `unsuffixedConvention`** stay filament-only. Process and machine
  rules never call them. Printer codes don't map one-to-one to models: `@BBL X1C` processes list
  the X1 Carbon, X1, P1S and X1E. So process rules match by `compatible_printers`, never by
  `modelAbbreviations`.

**Parent existence must check `instantiation` (all types, both slicers).**

- Studio keeps `instantiation: "false"` system presets only in `config_maps`, never in the preset
  collection (`libslic3r/PresetBundle.cpp:6718-6728@v02.09.01.70`). Orca does the same
  (`libslic3r/PresetBundle.cpp:7856-7860, 7971-7977@v2.5.0`).
- So a user preset whose `inherits` names `Generic PLA @base` or `fdm_process_common` is an orphan
  in the slicer.
- Today `resolve.ts` calls it healthy. Step 1 fixes that: the lookup built by `scan` answers a
  name only when the body says `instantiation` is true.
- An unreadable body still counts as present, which is the existing conservative rule.
- No fixture or live preset has such a parent, so §2.3 still holds. Add a `CHANGELOG` "Fixed"
  line for it.

### 4.4 Resolving and the rule context

- `scan` builds **one `RuleContext` per type**: `{ type, system: index[type], presets: presets of
  that type, resolve: { system: lookup[type], userByName: buildUserIndex(presets of that type) } }`.
- `RuleContext` gains `type: PresetType` and `profile: SlicerProfile`.
- `resolve.ts` doesn't change.
- `studioNameLookup` stays the Bambu lookup, with the `instantiation` filter from §4.3 added.
  Step 3 adds the Orca lookup next to it (§6.4).
- `checkR1(preset, ctx)` dispatches on `preset.type`:
  - filament goes to today's code, unchanged (it stays in `rules/r1.ts`);
  - process goes to `rules/r1Process.ts` (new);
  - machine goes to `rules/r1Machine.ts` (new).
- The cases where the chain ends at a user parent (`missing` with links, `cycle`, `tooDeep`) stay
  shared in `r1.ts`. Their texts use `TERMS[type]`, and the filament text is unchanged.
- The user parents R1 suggests are tracked per type, and so are the R4 rename blockers. A process
  can share a name with a filament.

### 4.5 R1 for process presets: `rules/r1Process.ts`

**Name shape.** All 316 distinct BBL names across 88 tags match this. Orca vendors use the same
shape with longer tags:

```ts
// names.ts (S1)
const PROCESS_NAME_RE = /^(\d+(?:\.\d+)?)mm (.+?) @(.+?)(?: (\d+(?:\.\d+)?) nozzle)?$/;
export interface ParsedProcessName { layer: string; profile: string; tag: string; nozzle?: string }
export function parseProcessName(name: string): ParsedProcessName | null;
/** Case-insensitive, runs of whitespace collapsed, trimmed. Used for "same name" checks. */
export function looseName(name: string): string;
```

Examples:

- `0.20mm Standard @BBL X1C` parses to `{layer:'0.20', profile:'Standard', tag:'BBL X1C'}`.
- `0.24mm Balanced Quality @BBL P2S 0.6 nozzle` parses with `nozzle:'0.6'`.
- `0.20mm Standard @Elegoo CC 0.4 nozzle` is an Orca name. Orca's Elegoo processes spell
  out `0.4 nozzle`.
- BBL never does. BBL process names never had an explicit `0.4 nozzle`, so filament's
  suffix ambiguity doesn't exist for them.

**The target** describes what the missing parent covered. These sources are tried in order:

1. The orphan's own `compatible_printers`, when it is non-empty. That is never the case in live
   data, but Studio allows it.
2. The current system processes with the same `tag` (case-insensitive) and the same nozzle (the
   name's suffix, or 0.4 when there is none). The target is the union of their effective
   `compatible_printers` entries for that nozzle. Source `tag`.
3. Otherwise, the effective `compatible_printers` of the system process whose `setting_id`
   equals the orphan's `.info` `base_id`. Source `baseId`. For processes `base_id` is reliable:
   it matched the parent's `setting_id` in 13 of 13 live presets, against 24 of 38 for filaments.
4. Otherwise the target is unknown.

The target nozzle is `parsed.nozzle`. Without one, it is the nozzle shared by every target
printer entry, or `'0.4'` when that is unknown.

**The candidate pool** has two parts:

- system processes whose body has `instantiation` set and whose name parses, so `fdm_process_*`
  templates are skipped;
- `process/base/` user presets with a system parent (or none) whose file stem equals their name,
  the same rule as filament (§10 q2 in SPEC).

Each candidate gets `printers` set to its effective `compatible_printers`.

**Ranking.** `covers(c)` means c's printers include every target entry. `overlaps(c)` means they
include at least one.

| Tier | Rule | Reason text (shape) |
|---|---|---|
| high | `looseName(c) === looseName(missing)` | "Same name, only capitalization or spacing differs." |
| high | same `layer` and same `profile` (case-insensitive), and `covers(c)` with the target known | "Bambu's current process for <printers>, <layer> mm <profile>." When the tag differs: "...Its name is for <tag>, but it lists your printers." (folding, as with X1C covering P1S) |
| medium | same `layer`, `covers(c)` (or, with the target unknown, the same `tag` and nozzle), other `profile` | "Same layer height and printer, but the <profile> profile, not <old profile>." These are the observed renames (Optimal to Standard, Extra Fine to High Quality, Fine to High Quality, Strength to Balanced Strength). Never pre-selected. |
| medium | same `layer`, `profile` and nozzle, other `tag`, `overlaps(c)` but doesn't cover | "Same profile, for some of the same printers (<list>)." |
| medium (raised) | c's `setting_id` is the orphan's `base_id` and the tier would be low | "Your preset's sync file (.info) says it was made from this preset." This is listed first among the medium candidates. |
| low | same `layer` and `profile`, other printers | "Same profile, but for <printers>." This covers code renames (H2 to H2S, N10 to H3C, N1 to A1M), where the old tag no longer exists. |
| low | same `tag` and nozzle, other `layer` | "Same printer, <layer> mm layers instead of <old>." Sorted by distance from the old layer height. |

Low candidates are not capped for processes (about 11 tags per profile): an alphabetical cut
dropped the right tag (`@BBL X2D` for an orphaned `@BBL N1`). Sorting uses today's comparator in `r1.ts`: confidence, then
sortKey, then system before user, then name. Pre-selection is also today's rule: a single high
candidate, or among several high ones, the one whose `setting_id` is `base_id`.

**The explanation** reuses today's intro with the per-type noun. When a new parent is picked,
the explanation and the diff description say that the printers change:

> "The new parent decides which printers Studio offers this process for: <printers>."

`planFixes` adds this to the description when the change is to a process preset and the
candidate has `printers`.

### 4.6 R1 for printer presets: `rules/r1Machine.ts`

When a printer preset is an orphan, Studio also loses the printer selection: `presets.machine`
falls back to the first visible printer (`libslic3r/PresetBundle.cpp:2157-2216@v02.09.01.70`).
The user must therefore **always pick**. `preselected` is always `false`.

**Parsing.** The missing name goes through `parseCompatiblePrinter`, which already parses
`"<model> <d> nozzle"`. Every selectable BBL machine name equals
`printer_model + " " + printer_variant + " nozzle"` in every tag.

**The pool** has two parts:

- system presets with `fileType === 'machine'` and `instantiation` set, using their
  **effective** `printerModel` and `printerVariant`, because the 0.6 variant inherits the
  0.4 one;
- `machine/base/` user presets, which are wizard printers, whose stem equals their name.

| Tier | Rule | Reason |
|---|---|---|
| high | `looseName` equal | "Same name, only capitalization or spacing differs." |
| high | effective `printerModel` equals the parsed model (case-insensitive) and `printerVariant` equals the parsed nozzle (`sameNozzle`) | "Bambu's current preset for the <model> with a <d> mm nozzle." |
| medium | same model, other nozzle | "Same printer, but the <d> mm nozzle. The nozzle changes the print settings, so only pick this if that's the nozzle you have." Sorted by nozzle distance. |
| medium | `setting_id` equals the orphan's `base_id` | "Your preset's sync file (.info) says it was made from this printer." |
| medium | same nozzle, and the missing model's last word is a printer code (it has a digit) that abbreviates the candidate's model (`modelMatchesCode`: `Bambu Lab X1C` for the X1 Carbon) | "Probably the same printer: "<code>" is short for the <model>." |
| low | same nozzle, other model, same vendor | "A different printer: <model>." Not capped (about 14 printers per nozzle; the user must be able to pick theirs), sorted by how many words the model name shares with the old one. |

Explanation suffix (always added):

> "Preset Doctor never picks a printer for you: choose the one you actually have."

### 4.7 R4 per type: `rules/r4.ts`

The checks are the same for every type. Only two things change:

- **Texts.** The `"Preset has no name"` text uses `TERMS[type].list`. Filament keeps
  `filament list`.
- **The rename fix** (`fix.ts:137-147`) uses `TERMS[type].settingsIdKey`. If the value equals the
  old name, a `string` shape becomes `setJsonStringField(after, key, newName)`. The `array0` shape
  keeps today's code.

Also:

- Rename blockers only look at presets of the same type and at that type's system index.
- `checkRenamedParents` in `fix.ts` keys renames by `type + "\u0000" + name`.
- No `type` key is required, and no new R4 checks are added in v0.2. Missing `version` and
  "already present" stay on the follow-up list (§11).

### 4.8 UI (step 1)

The goal is to keep the screen simple for non-developers.

- **Type tabs** go above the table as a segmented control: `Filament (178) · Process (10) ·
  Printer (0)`.
  - A tab is shown only for a type that has at least one preset. With filament presets only,
    there are no tabs, so the UI looks the same as today.
  - The default tab is the first type, in the order above, that has a row needing attention.
    Otherwise it is Filament.
  - Each tab carries a small count badge of the rows that need attention.
- **Filters.** The "Needs attention / All presets" filter and the search work within the
  current tab.
- **Base tag.** The `custom filament` tag becomes `TERMS[type].baseTag`.
- **Empty text.** The empty-table text uses `TERMS[type].noun`.
- **Detail panel.** Candidates show `printers` when present, collapsed beyond 3 entries
  ("+2 more").
- **Model.** `packages/ui/src/model.ts` adds `type` to `visiblePresets` (a new `tab:
  PresetType` argument) and adds `countByType(scan)`. `countByStatus` keeps its shape and gains
  the `unsupported` key in step 2.

### 4.9 CLI (step 1)

- **`--type <list>`.** A comma list or a repeated flag, with values `filament`, `process` and
  `machine` (`printer` is also accepted). The default is all types.
  - It filters what `scan` prints and which presets `fix` plans.
  - `--json` always prints the full result.
  - The exit code of `scan` considers only the selected types.
- **Text output.** When more than one type has presets, each status group lists its rows under
  `Filament:` / `Process:` / `Printer:` sub-headings, in that order. With one type present the
  output is byte-identical to today (§2.3).
- **Incomplete check.** The `INCOMPLETE` check uses `indexesRead[type]` for presets that have a
  parent.
- **Follow-up commands** keep `--type`, as they already keep `--user` (`fixHint`).

### 4.10 Fixture: `__fixtures__/types-bambu/` (step 1)

This fixture is generated by `scripts/make-fixtures.ts` from the live folder, which the script
only reads.

**System side.** The system presets are Bambu's public data. They are copied byte-for-byte, with
the full `inherits` and `include` chains, like today's filament subset. They include:

- processes `0.20mm Standard @BBL X1C`, `0.20mm Standard @BBL X2D`,
  `0.20mm High Quality @BBL X2D`, `0.16mm Standard @BBL H2D` and `0.20mm Standard @BBL A1M`,
  plus their templates;
- machines `Bambu Lab X1 Carbon 0.4 nozzle`, `Bambu Lab X2D 0.4 nozzle`,
  `Bambu Lab X2D 0.6 nozzle` and `Bambu Lab A1 mini 0.4 nozzle`, plus their `*_common`
  templates and every g-code template file they `include`.

`BBL.json` is trimmed the same way as today.

**User side.** The user presets are **synthesized**, not copied, because live process names are
the user's own.

- **Shape.** Alphabetical keys and 4-space indent. LF line endings with no final newline, plus
  one CRLF file.
- **Keys.** `name`, `inherits`, `from: "User"`, `version: "2.8.0.6"`, `print_settings_id` or
  `printer_settings_id`, and 2 to 3 override keys copied from the parent.
- **Sidecars.** Fake `setting_id` (`PPUS` / `PMUS` + fake hex), `user_id 1000000001`,
  `base_id` as listed below, `sync_info` empty, and a fixed `updated_time`.
- **Filament presets.** One healthy filament preset, so mixed-type output is tested.

| File (`user/1000000001/...`) | `inherits` | Expected |
|---|---|---|
| `process/0.20mm Standard @BBL X1C - Copy.json` | `0.20mm Standard @BBL X1C` | ok |
| `process/Case Only.json` | `0.20mm standard @BBL X1C` | R1 high, pre-selected `0.20mm Standard @BBL X1C` |
| `process/Added Suffix.json` | `0.20mm Standard @BBL X2D 0.4 nozzle` | R1 high (covers X2D 0.4), pre-selected `0.20mm Standard @BBL X2D` |
| `process/Old Profile Word.json` | `0.20mm Optimal @BBL X2D` | R1 medium `0.20mm Standard @BBL X2D` and `0.20mm High Quality @BBL X2D`; nothing pre-selected |
| `process/Old Code.json` (base_id = setting_id of `0.20mm Standard @BBL A1M`) | `0.20mm Standard @BBL N1` | R1 medium (raised by base_id) `0.20mm Standard @BBL A1M`; nothing pre-selected |
| `process/No Candidates.json` | `0.33mm Weird @BBL ZZZ` | R1, no candidates |
| `process/Name Mismatch.json` (`name` and `print_settings_id` = `Name Mismatch Old`) | `0.20mm Standard @BBL X2D` | R4 rename, which also rewrites `print_settings_id` |
| `process/Template Parent.json` | `fdm_process_common` | R1 (not instantiable), no high candidate |
| `machine/Bambu Lab X1 Carbon 0.4 nozzle - Copy.json` | `Bambu Lab X1 Carbon 0.4 nozzle` | ok |
| `machine/Case Only Printer.json` | `Bambu Lab X1 carbon 0.4 nozzle` | R1 high, **not** pre-selected |
| `machine/Old Model Name.json` (base_id = setting_id of A1 mini 0.4) | `Bambu Lab N1 0.4 nozzle` | R1 medium A1 mini 0.4, not pre-selected |
| `machine/base/My Printer 0.4 nozzle.json` | (none) | ok, `Custom printer, not based on another preset` |

The README gets a section for this table, written from the generator's computed output, as
today.

### 4.11 Step 1 as built: deviations and choices

Where the code differs from §2 to §4.10, this list is the contract.

- **Process ranking, one extra high tier.** Same `layer`, `profile`, `tag` and nozzle (the name's
  suffix, or 0.4 without one) ranks high: "Same name, with the nozzle size written out or left
  out." It sits right after the `looseName` tier. Without it, `0.20mm Standard @BBL X2D 0.4 nozzle`
  only reaches high through the `covers` tier, which needs a known target. The simulation
  (below) pre-selects such spellings correctly in every case.
- **A target known only from `base_id` never makes a candidate high.** The `covers` high tier
  needs the target from `own` or `tag`. With target source `baseId`, a same-layer, same-profile
  candidate that covers it is medium ("Same layer height and profile, for the printers of the
  preset your sync file (.info) names."). This is what the `Old Code` row of §4.10 expects
  (nothing pre-selected), and it matches the filament rule that `base_id` is cloud metadata
  that only raises a candidate.
- **Printer ranking.** "Same vendor" in the low tier is "the model's first word is the same"
  (`Bambu` in `Bambu Lab ...`). The `base_id` tier is checked before "same model, other
  nozzle", so the named printer is listed first among the medium ones.
- **`RuleContext.type` and `profile` are optional** (default `filament` and `BAMBU`), so code and
  tests that build a context by hand keep compiling. `scan` always sets both.
- **`SystemIndexSet`** has `errors: Partial<Record<PresetType, SystemIndexError>>` next to
  `byType`, and no `opaque` field yet (S3 adds it). `version` is the filament index's version,
  which for Bambu is BBL's, as specified.
- **Missing process or printer files** are handled as for filament: the entry is left out of the
  index and a warning names the file. Only an index that can't be read, or a list that is not a
  list, is a `SystemIndexError`.
- **Index warnings.** A process or printer index error becomes a warning only when the filament
  index loaded. When it didn't, the filament warning already says that the system presets
  can't be read. `indexesRead` is set either way.
- **`Candidate.printers`** is set for process candidates only. Filament candidates don't get it
  yet, so filament findings stay exactly as they were.
- **`slicerVersion`** is not added in step 1. It is marked (S3) and Bambu would always be `null`.
- **CLI sub-headings** appear when more than one type is shown, after `--type` filtering. So
  `--type printer` on a mixed folder prints no sub-headings. The fix summary for a printer
  finding says "N possible replacement(s); pick the printer you have in the app".
- **UI copy.** The intro heading ("Check your filament presets") and the header tagline are
  unchanged, so a filament-only folder looks exactly as before (§4.8). Changing them is a
  release-copy decision, with new screenshots.
- **`scripts/r1-simulate.ts`** also runs process and printer scenarios
  (`packages/core/src/testing/r1TypeSimulation.ts`). Process: every instantiable system process
  is hidden, or renamed to a lower-case spelling or to its name plus ` 0.4 nozzle`, with and
  without a `base_id`. A pre-selection is right when it keeps the layer height and lists every
  printer the original listed. Printer: every printer is hidden, and any pre-selection is wrong.
  On the live system profile 02.08.00.06 (read-only): 556 process scenarios, all 323 renamed
  spellings pre-selected correctly, 0 wrong; 56 printer scenarios, none pre-selected. The
  filament numbers are unchanged.

---

## 5. Feature 2: the "Unsupported" helper, R2/R3 (step 2)

### 5.1 What users see, and why

A **loaded** preset that doesn't fit the selected printer is still visible in some cases and
hidden in others:

- **Filaments** go to the bottom group "Unsupported presets", greyed out with a red flag
  (`slic3r/GUI/PresetComboBoxes.cpp:1717-1729, 1851@v02.09.01.70`).
- **Processes** have no such group. An incompatible process is left out of the list unless it is
  the selected one (`slic3r/GUI/PresetComboBoxes.cpp:2126-2135@v02.09.01.70`). The "show
  incompatible" button seems to be disabled (`slic3r/GUI/Tab.cpp:290, 656-657@v02.09.01.70`).
  Confidence: medium. This goes on the checklist (§10).
- **Printers** have no compatibility check. A user printer preset has no vendor, so it is always
  visible (`libslic3r/Preset.cpp:873-884@v02.09.01.70`, early return at `:877`). **R2/R3 never
  apply to printer presets.**
- **Orca 2.4 and later** show the "Unsupported presets" group only when Preferences >
  Developer > "Show unsupported presets" is on. That option is off by default
  (`slic3r/GUI/PresetComboBoxes.cpp:1505-1507@v2.5.0`). Orca 2.3.x always shows the group
  (`slic3r/GUI/PresetComboBoxes.cpp:1356@v2.3.2`).

R1 and R4 already cover presets that aren't loaded at all. R2/R3 explain the loaded ones. The
live data has 46 filaments and 1 process that suit only printers that haven't been added (R2),
plus 80 presets that suit another printer that has been added (R3b). All 46 filaments turned
out to be per-printer copies of custom filaments that Studio lists under one name, each group
with a copy for an added printer; §5.10 makes them a grouped note instead of Unsupported rows.

### 5.2 Conf inputs: `conf.ts`

```ts
export interface SlicerConf {
  found: boolean;
  error?: string;
  syncUserPreset?: boolean;                    // unchanged
  /** presets.machine */
  selectedPrinter?: string;
  /** presets.process; Orca: the fallback in §6.2 */
  selectedProcess?: string;
  /** models[]: enabled printers. nozzles split from "0.2;0.4;0.6". Empty array is a real value. */
  enabledModels?: { vendor: string; model: string; nozzles: string[] }[];
  /** (S3) Orca */
  header?: string;
  cloudProviders?: string[];
  showUnsupportedPresets?: boolean;
  presetFolder?: string;
}
export async function readSlicerConf(fs: PresetFs, profile: SlicerProfile): Promise<SlicerConf>;
export type StudioConf = SlicerConf;           // kept for existing imports
```

- **Parsing.** The `# MD5 checksum` trailer is removed first, with today's `stripTrailer`. The
  new fields are read only from **valid JSON**. The regex fallback still recovers only
  `sync_user_preset`.
- **Section shapes.** `presets` must be an object and `models` an array, otherwise the field is
  left undefined. A `models` entry without a string `model` is skipped.
- **Fields never read:** `access_code`, `user_last_selected_machine`, `nozzle_volume_types`
  (which says nothing about compatibility; written at `libslic3r/AppConfig.cpp:1477-1497@v02.09.01.70`),
  `N6`/`N7`, `download_path`, `last_backup_path` and `slicer_uuid`.
- **Where Studio reads these keys:** `presets.*` at
  `libslic3r/PresetBundle.cpp:2157-2172@v02.09.01.70`, and `models[]` through `get_variant` at
  `libslic3r/AppConfig.cpp:696-707, 1199-1205@v02.09.01.70`.
- **Global, not per account.** `presets.*` is one global selection. R2 is therefore defined
  against the **enabled** printers, and only the grouped note uses the selected printer.

### 5.3 The algorithm: `packages/core/src/compat.ts` (new, pure)

**Inputs, built once per scan in `scan.ts`:**

```ts
export interface PrinterRef {
  name: string;
  model?: string;          // effective printer_model (system) or of its system ancestor (user)
  nozzle?: string;         // effective printer_variant
  /** Vendor id of the nearest system ancestor (the preset itself if system); null for root user printers. */
  vendor: string | null;
  isUser: boolean;
  /** User printers: their direct inherits (Studio checks one level only). */
  inherits?: string;
}

export interface CompatInputs {
  /** E: enabled system printers + every loaded (not R1/R4-broken) user printer. */
  enabled: PrinterRef[];
  /** S: the conf's presets.machine, resolved among loaded printers; undefined if absent or not loaded. */
  selected?: PrinterRef;
  selectedProcess?: string;
  /** Every system printer by name (enabled or not), for mapping L entries to model + nozzle. */
  knownPrinters: ReadonlyMap<string, PrinterRef>;
  enabledModels: { vendor: string; model: string; nozzles: string[] }[];
  vendorCheck: boolean;                     // profile.vendorCheck
}
```

**How E is built.**

- A **system printer** is in E when all of these hold:
  - its body has `fileType === 'machine'` and `instantiation` set;
  - its index vendor equals the `vendor` of some `models[]` entry;
  - its effective `printerModel` equals that entry's `model`;
  - its `printerVariant` is among that entry's `nozzles`.

  This mirrors `set_visible_from_appconfig` (`libslic3r/Preset.cpp:879-884@v02.09.01.70`).
- **User printers** are always in E. They are matched by their own name and by their direct
  `inherits`.

**The effective values of a preset P** (filament or process):

```ts
export interface EffectiveCompat {
  printers: string[] | null;     // L; null = no preset in the chain sets it
  printersCondition: string;     // C; '' when unset
  prints: string[] | null;       // filament only
  printsCondition: string;
  vendor: string | null;         // nearest system ancestor's vendor (get_preset_with_vendor_profile, Preset.cpp:2921-2933@v02.09.01.70)
  /** Where L came from: P itself, a named ancestor, or the name rule below. */
  source: { kind: 'own' } | { kind: 'inherited'; from: string } | { kind: 'name' } | { kind: 'default' };
  /** (S3) The chain reached an .opc vendor whose values can't be read. */
  opaque?: boolean;
}
```

A key is P's own value **if P's file has it**, even when that value is `[]` or `""`. Otherwise it
is the value of the nearest ancestor that has it, walking user parents and then system parents.
That matches what the loader does (`libslic3r/Preset.cpp:1521-1526@v02.09.01.70`).

**The filament name rule.** Take a user filament with no `inherits` whose effective `L` is empty.
L becomes `[name.slice(name.indexOf('@') + 1)]` (first `@`, untrimmed) when that is non-empty.
Studio does the same at load and writes it back to the file
(`libslic3r/Preset.cpp:1549-1559@v02.09.01.70`), and so does Orca
(`libslic3r/Preset.cpp:1950-1959@v2.5.0`). Source `name`. A user filament based on such a root
(no system preset in its chain) that sets no `L` of its own, or whose `L` comes from the root's
own `[]`, inherits the rewritten list, because Studio loads base/ first and children copy the
root's config (`libslic3r/Preset.cpp:1520-1524@v02.09.01.70`). Source `inherited` from the root.

**`judgeCompat(P, type, inputs)` returns a `CompatVerdict`.** The steps run in order:

1. If `opaque`, the verdict is **`cant-tell`**.
2. **The vendor filter** applies when `vendorCheck` is on and `P.vendor !== null`. A printer
   whose `vendor !== P.vendor` is incompatible, before Studio looks at the list or the condition
   (`libslic3r/Preset.cpp:823-825@v02.09.01.70`). Let E′ be E without those printers.
   - If `L` is empty, E′ is empty and E isn't, the verdict is **`other-vendor`** (for a
     non-empty `L`, step 7 decides it).
   - So a BBL-based filament on a wizard printer (vendor null) is incompatible. That is why the
     wizard makes its own copies (`libslic3r/Preset.cpp:2560-2616@v02.09.01.70`).
   - Orca has no vendor check (`libslic3r/Preset.cpp:904-907, 942-945@v2.5.0`).
3. If `L` is empty and `C` is not, the verdict is **`cant-tell`**. Studio evaluates `C`, and
   Preset Doctor never guesses (`libslic3r/Preset.cpp:829-837@v02.09.01.70`). Live BBL and Orca
   profiles have no conditions at all.
4. If `L` is empty and `C` is empty: when S fails step 2 but E′ isn't empty, the verdict is
   **`other-printer`** with E′ as `matchedPrinters`; otherwise it is **`all`**. Filaments then
   go on to step 8 after `all`.
5. `matches(x)` means L contains `x.name`, or `x.isUser` and L contains `x.inherits`
   (`libslic3r/Preset.cpp:811-819, 838-842@v02.09.01.70`). If S passes step 2 and
   `matches(S)`, the verdict is **`selected`**. Filaments then go on to step 8.
6. If some x in E′ has `matches(x)`, the verdict is **`other-printer`**, with
   `matchedPrinters`. This is the grouped R3b.
7. If an added printer outside E′ matches, the verdict is **`other-vendor`**. If an entry of L
   is the file name of one of the account's printer presets that R1/R4 hide or break, the
   verdict is **`printer-hidden`** (R2): repairing that printer brings the preset back.
   Otherwise, map each entry of L through `knownPrinters`. An entry that isn't there falls back to
   `parseCompatiblePrinter` and is marked `guessed: true`.
   - a. If some entry's model is an enabled model (`enabledModels` with the same vendor and
     model) but the entry's nozzle isn't in its `nozzles`, the verdict is
     **`nozzle-not-added`** (R3).
   - b. Else, if at least one entry is a known printer, the verdict is **`printer-not-added`**
     (R2). It lists the known ones in `printers` and the unknown ones in `unknownNames`.
   - c. Else, every entry is unknown, and the verdict is **`unknown-printers`** (R2 variant).
8. **Filament against the process** (only after `all` or `selected`, and only when
   `selectedProcess` is known):
   - if `prints` is non-empty and doesn't contain `selectedProcess`, set `process: 'mismatch'`
     (this is grouped R3c);
   - if `prints` is empty and `printsCondition` isn't, set `process: 'cant-tell'`
     (`libslic3r/Preset.cpp:784-804@v02.09.01.70`).

   Processes are never checked against a filament (`libslic3r/PresetBundle.cpp:7382@v02.09.01.70`).

**Not modelled.** Studio's multi-diameter mode (`libslic3r/Preset.cpp:3105-3110@v02.09.01.70`)
lives in the project file, not the conf, so Preset Doctor can't see it. The R3b text mentions
it.

**Which presets are judged.**

- Every loaded filament and process preset is judged.
- **Skipped:** presets with an R1 or R4 finding of status `hidden` or `broken`, and presets whose
  chain passes through such a preset.
- A preset whose file has `"instantiation": "false"` is also skipped: Studio loads it but never
  shows it (`libslic3r/Preset.cpp:1505-1506@v02.09.01.70`).
- `process/base/` wizard processes list a user printer name. They are judged normally, because
  user printers are in E.

**When R2/R3 don't run.** `ScanResult.compat.checked = false`, with `why`, in these cases:

- the conf is missing (`no-conf`);
- the conf is unreadable or not valid JSON (`conf-unreadable`);
- `models` is absent and there is no selected printer (`no-printers`);
- the machine index isn't readable (`system-unreadable`).

In those cases no finding and **no warning** are added, so §2.3 holds for every existing
fixture. The UI and CLI show one muted line, described in §5.7.

### 5.4 Output: findings, statuses, grouping

| Verdict | Per preset | Status / severity | Rule id |
|---|---|---|---|
| `all`, `selected` | `summary.compat` only | unchanged (`ok`) | none |
| `cant-tell` | `summary.compat` only; the detail panel says why | unchanged | none |
| `other-printer`, or `process: 'mismatch'` | `summary.compat` only | unchanged | counted in one scan-level `R3_NOT_FOR_SELECTION` |
| `nozzle-not-added` | Finding | `unsupported` / `info` | `R3_NOZZLE_NOT_ADDED` |
| `printer-not-added`, `unknown-printers`, `other-vendor` | Finding | `unsupported` / `info` | `R2_PRINTER_NOT_ADDED` |
| any R2/R3 verdict with `family` (§5.10) | Finding (a note) | `info` / `info` | `R2_PRINTER_NOT_ADDED` or `R3_NOZZLE_NOT_ADDED`, counted in one scan-level `R2_FAMILY_COPIES` |

- **Status rank.** `STATUS_RANK` becomes ok 0, info 1, unsupported 2, hidden 3, broken 4. The UI's
  `STATUS_ORDER` becomes hidden, broken, unsupported, info, ok.
- **Labels.** The status label is **"Unsupported"**, the word Studio uses, and the CLI group
  label is "Loaded, but not offered for your printers".
- **Attention and exit codes.** `isProblem` counts `unsupported` as needing attention. The CLI
  exit code is unchanged: only `hidden` and `broken` give exit 1.
- **The grouped note** (`R3_NOT_FOR_SELECTION`) is added only when its count is above zero.
  - It has `presetPath` set to the conf path, `status: 'info'` and `severity: 'info'`.
  - Title: "Some presets are for another printer you've added".
  - Explanation: "N filament and M process presets are made for another printer or nozzle you've
    added in <Studio> (for example <up to 3 names>). <Studio> shows them when you select that
    printer, so nothing is wrong with them."
  - When at least one of them is for the same model as S with another nozzle, it adds: "If you
    use more than one nozzle size in one project, some may already show."
  - When there is a process mismatch, it adds "K filament presets are only for other process
    presets."
- **Summary reasons**, for `PresetSummary.reason`:
  - `R2`: `Only for printers you haven't added (<first printer>[, +n])`.
  - `R3`: `Made for the <d> mm nozzle, which you haven't added`.
  - `unknown-printers`: `Lists printers <Studio> doesn't know`.
  - `other-vendor`: `Made for another brand's printer profile`.

### 5.5 Texts

These texts sit in `rules/r2r3.ts`, and the per-type and per-slicer pieces come from `TERMS` and
the profile. `<where>` depends on the type:

- **Filament:** `lists it under "Unsupported presets" (greyed out)`.
- **Process:** `doesn't offer it in the process list`.
- **Orca with `unsupportedGroup(conf) === 'hidden-by-setting'`:** `doesn't show it in the list at
  all (OrcaSlicer hides unsupported presets unless Preferences > Developer > "Show unsupported
  presets" is on)`.

**R2 (`printer-not-added`)**

> "<Studio> loads this <noun>, but <where> for every printer you've added. It is made for
> <printers>, which you haven't added in <Studio>. Its printer list <comes from its own settings |
> is inherited from "<from>">. To use it, add that printer in <Studio>'s printer selection. If you
> no longer have that printer, you can ignore this preset or delete it in <Studio>."

**R2 (`unknown-printers`)**

> "... It lists printer names <Studio> doesn't know (<names>), probably printers that were renamed
> or removed in an update. To keep using these settings, create a new preset for your printer in
> <Studio> and copy the settings over."

**R2 (`other-vendor`)**

> "... It is based on <vendor>'s presets, and <Studio> only offers those for <vendor> printers.
> Your printers that fit its list use another profile (for example a printer you created
> yourself)."

With no printer list (every added printer is of another vendor), that second sentence would be
wrong, so it reads instead:

> "... It is based on <vendor>'s presets and has no printer list of its own, so <Studio> offers
> it for every printer that uses a <vendor> profile. None of the printers you've added uses one
> (a printer you created yourself, for example, has no brand profile)."

**R3 (`nozzle-not-added`)**

> "... It is made for the <model> with a <d> mm nozzle, and you've added the <model> only with the
> <list> mm nozzle. To use it, add the <d> mm nozzle for that printer in <Studio>'s printer
> selection."

Three rules hold for every one of these texts:

- A name marked `guessed` is followed by "(Preset Doctor read this from the printer's name)".
- No text promises an exact UI path that wasn't confirmed. The checklist step in §10 verifies the
  "printer selection" wording.
- None suggests editing files.

### 5.6 `CompatDetail` and `CompatContext`

```ts
export type CompatState =
  | 'all' | 'selected' | 'other-printer' | 'cant-tell'
  | 'nozzle-not-added' | 'printer-not-added' | 'unknown-printers' | 'other-vendor';

export interface CompatDetail {
  state: CompatState;
  /** L as resolved; [] for 'all'. */
  printers: string[];
  /** Where L came from: 'own' | 'inherited' | 'name' | 'default', with `from` for inherited. */
  source: EffectiveCompat['source'];
  /** Enabled printers that match (other-printer). */
  matchedPrinters?: string[];
  unknownNames?: string[];
  guessed?: boolean;
  /** Filament vs selected process. */
  process?: 'mismatch' | 'cant-tell';
  /** cant-tell: why ('condition' | 'opaque'). */
  why?: 'condition' | 'opaque';
}

export interface CompatContext {
  checked: boolean;
  why?: 'no-conf' | 'conf-unreadable' | 'no-printers' | 'system-unreadable';
  selectedPrinter?: string;
  selectedProcess?: string;
  /** Grouped for display: one entry per enabled model. */
  enabled: { vendor: string; model: string; nozzles: string[] }[];
  /** Number of user printer presets counted as enabled. */
  userPrinters: number;
  unsupportedGroup: 'shown' | 'hidden-by-setting';
}
```

### 5.7 UI and CLI (step 2)

- **`PrintersStrip.tsx`** (new) sits above the table and is shown when `compat.checked` is true:
  > "Printers added in Bambu Studio: X2D (0.2, 0.4, 0.6, 0.8 mm) · P1S (0.4 mm) · …. Selected:
  > X2D 0.4 nozzle."

  When `checked` is false, it shows one muted line instead:
  > "Printer checks skipped: <reason in plain words>."

  The grouped R3 note sits under it as a one-line banner with a "Show them" link. The link
  switches the filter to "All" and sets the search filter `compat:other`. That filter is
  implementer's choice, as long as it lists exactly those rows.
- **Detail panel.** For any preset with `compat`, it adds a "Printers" section:
  - "Offered for: <L>" (or "every printer");
  - where that list comes from;
  - for an R2 or R3 finding, its explanation in place of the fix area, with no checkbox and no
    candidates.
- **Badge and model.** `StatusBadge` gets an `unsupported` style (amber, distinct from the red
  hidden). `model.ts` adds the label and the order.
- **CLI.** A new group goes after "Broken": `Loaded, but not offered for your printers (n)`. The
  R3 note is printed like R5 (`Note: ...`).
  - The summary line adds `, n unsupported` **only when n > 0**.
  - When `compat.checked` is false, nothing extra is printed. That keeps old fixture output
    identical.

### 5.8 Fixture: `__fixtures__/unsupported-bambu/` (step 2)

- **System subset.** Live system files are copied:
  - machines X2D 0.4/0.6/0.8, P1S 0.4, X1 Carbon 0.4, H2D 0.4, plus their templates;
  - processes `0.20mm Standard @BBL X2D`, `0.20mm Standard @BBL X1C` (lists P1S 0.4),
    `0.16mm Standard @BBL H2D` and `0.40mm Standard @BBL X2D 0.8 nozzle` (or whichever X2D 0.8
    process exists; the generator picks it and records it);
  - filaments `Generic PLA @BBL X2D 0.4 nozzle`, `Generic PLA @BBL H2D` and `Generic PLA @base`.
- **Conf.** `BambuStudio.conf` is **synthesized**, with only these keys plus the MD5 trailer:

  ```json
  { "app": { "sync_user_preset": false },
    "models": [ { "vendor": "BBL", "model": "Bambu Lab X2D", "nozzle_diameter": "0.4;0.6" },
                { "vendor": "BBL", "model": "Bambu Lab P1S", "nozzle_diameter": "0.4" } ],
    "presets": { "machine": "Bambu Lab X2D 0.4 nozzle", "process": "0.20mm Standard @BBL X2D",
                 "filaments": ["Generic PLA @BBL X2D 0.4 nozzle"] } }
  ```

- **User presets.** All are synthesized and live in `user/1000000001/...`:

| File | Setup | Expected |
|---|---|---|
| `process/On X2D.json` | inherits `0.20mm Standard @BBL X2D` | `selected`, no finding |
| `process/On P1S.json` | inherits `0.20mm Standard @BBL X1C` | `other-printer` (P1S), counted in the R3 note |
| `process/On H2D.json` | inherits `0.16mm Standard @BBL H2D` | R2 `printer-not-added` (H2D 0.4) |
| `process/On X2D 08.json` | inherits the X2D 0.8 process | R3 `nozzle-not-added` (X2D 0.8; 0.4 and 0.6 added) |
| `filament/Unknown Printer.json` | inherits `Generic PLA @BBL X2D 0.4 nozzle`, own `compatible_printers: ["Bambu Lab Q9 0.4 nozzle"]` | R2 `unknown-printers`, `guessed` |
| `filament/Condition Only.json` | own `compatible_printers: []`, `compatible_printers_condition: "nozzle_diameter[0]==0.4"` | `cant-tell`, no finding |
| `filament/Other Process.json` | own `compatible_prints: ["0.12mm Fine @BBL X2D"]` | `selected` + `process: 'mismatch'`, counted in the R3 note |
| `filament/base/My PLA @Bambu Lab H2D 0.4 nozzle.json` | no inherits, empty `compatible_printers` | name rule gives L = [`Bambu Lab H2D 0.4 nozzle`], so R2 |
| `machine/My X2D.json` | inherits `Bambu Lab X2D 0.4 nozzle` | printer row ok; no R2/R3 for printers |
| `process/base/For My X2D.json` | no inherits, `compatible_printers: ["My X2D"]` | `other-printer` (user printer My X2D), counted in the note |

`compat.ts` also gets unit tests (memFs) for these cases:

- the vendor check;
- a user printer that inherits another user printer, where only one level counts and the
  preset is therefore R2;
- an empty `models: []`;
- `presets.machine` naming a printer that isn't loaded.

### 5.9 Step 2 as built: deviations and choices

Where the code differs from §5.1 to §5.8, this list is the contract.

- **Files.** `compat.ts` holds the inputs and verdicts (`effectiveCompat`, `systemPrinters`,
  `userPrinter`, `judgeCompat`, `compatSetup`), `rules/r2r3.ts` the texts, findings, row reasons
  and the grouped note. Both are exported from `index.ts`. The pass is `compatPass` in `scan.ts`;
  it runs after R1 and R4 for every type, so it knows which presets are hidden or broken.
- **Other vendor (step 4).** The verdict is `other-vendor` only when an added printer of another
  vendor fits the list (`matchedPrinters` names it). When no added printer fits the list at all,
  the verdict goes on to step 7, because "made for the H2D, which you haven't added" says more than
  "another brand's profile". A preset with no system ancestor has no vendor and is never filtered.
- **`CompatDetail` has four more fields:** `model`, `nozzles` and `addedNozzles` for
  `nozzle-not-added` (the R3 text needs them), and `vendor` for `other-vendor`.
- **`guessed`** is set when a list entry that no profile defines was read with the
  `<model> <d> nozzle` pattern: on `unknown-printers` and `printer-not-added` whenever such an
  entry exists, on `nozzle-not-added` only when the entry it is about was read that way (only that
  text states a model or size from a name, so only it carries the "(Preset Doctor read this ...)"
  note).
- **The selected printer (S).** `presets.machine` (with a `.ini` suffix removed, as Studio does)
  is looked up among the instantiable system printers by Studio's name first, then among the
  loaded user printers by file name. When found, it counts as added even if `models` doesn't list
  it. When the conf has no `models` but names a selected printer, E is the user printers plus S.
  When S isn't found, `compat.selectedPrinter` is absent, no preset is `selected`, and
  `other-printer` presets are not counted in the grouped note ("another printer" needs a
  selected one); filament process mismatches still are.
- **E.** User printers that R1 or R4 report as hidden or broken, or whose file says
  `"instantiation": "false"`, are not added. A user printer's model and nozzle come from its own
  file, then its user parents, then its system ancestor.
- **Skipped reasons, in order:** `no-conf`; then, when the conf has neither `models` nor
  `presets.machine`, `conf-unreadable` if it had an error, else `no-printers`; then
  `system-unreadable` (no machine index). A valid JSON conf without an `app` section still gives
  its printers.
- **Texts.** `<where>` carries its own quantifier: filament `lists it under "Unsupported presets"
  (greyed out) for every printer you've added`, process `doesn't offer it in the process list
  for any printer you've added`. R2 says "add that printer" for one printer and "one of those
  printers" for several; a `printer-not-added` list with unknown names adds "It also lists printer
  names Studio doesn't know (...)". The source sentence for the name rule is "Its printer list
  comes from its name (the part after "@"), as Studio reads it."
- **The grouped note.** The multi-nozzle sentence is added only when a counted preset's matched
  printer has S's model and a **different** nozzle (a user printer of the same model and nozzle
  doesn't count). With only process mismatches, the title is "Some filament presets are for another
  process preset" and the sentence names up to three of them.
- **CLI.** When the checks ran, the header gets a `Printers: <model> (<sizes> mm), ...; selected:
  <name>` line, and the "Loaded, but not offered for your printers" group is printed (also with
  0 rows). When they didn't run, neither is printed, so old output is byte-identical.
- **UI.** The "Show them" filter is the search text `compat:other` (exactly the rows the note
  counts); when the open tab has none of them, it switches to the first tab that has. The toolbar
  adds "N unsupported" only when N > 0. `orderFindings` breaks severity ties by status, so an R2
  finding is the main one over an R4 "no sync file" note. The detail panel's "Printers" section
  sits under the main finding, with a line saying Preset Doctor doesn't change the list.
  `DetailPanel` takes an optional `slicer` name (default Bambu Studio).
- **Desktop e2e** opens a temp copy of `unsupported-bambu` too: the printers strip, the tabs, the
  Unsupported rows and badge, the detail panel and "Show them". `PRESET_DOCTOR_E2E_SHOTS=<dir>`
  saves screenshots of that part; it never writes `docs/screenshots`.
- **Live (read-only, on a temp copy, Nov 7, 2026).** Account A: 46 filaments and 1 process
  (`0.16mm ... H2D`-based) R2, no R3, 77 filaments and 2 processes in the grouped note (one of them
  for the X2D 0.6 nozzle, so the multi-nozzle sentence shows), 18 hidden (R1) not judged. Account B:
  its 3 processes are all in the note, its 18 filaments are R1 orphans. `npm run test:live` adds a
  structural check (`compat.test.ts`), not these counts. After §5.10, account A has 1 R2 row
  that needs attention: the process.

### 5.10 Copies of one custom filament (after step 2)

**Problem.** On the live data (account A) R2 marked 46 filaments Unsupported, each its own row
needing attention. All 46 are per-printer copies, in 13 groups that share the name before "@",
and every group has a copy that is `selected` for an added printer. Studio shows each group as
one entry, so 46 "Unsupported" rows buried the 18 hidden presets the user has to act on.

**What Studio does** (`@v02.09.01.70`):

- "Create filament" clones the template once per printer: `clone_presets_for_printer`
  (`libslic3r/Preset.cpp:2603-2616`) names each copy `<prefix> @<printer>` (prefix: the name up
  to " @") with `compatible_printers = [<printer>]`; `clone_presets` clears `inherits` (`:2562`)
  and sets the alias (`:2585-2586`).
- `set_custom_preset_alias` (`:3470-3490`) gives an alias only to a **user filament** preset
  whose `inherits` is empty: the name (the file name, `:1455`) up to the first `@`, trailing
  spaces trimmed. No `@`, or nothing before it: no alias. It runs at load (`:1567`), after the
  name rule (`:1549-1559`). The alias is **not** set when `is_alias_exist` (`:2975-2995`) finds
  another preset with that alias already holding one of the printers in this preset's list
  (`set_printer_hold_alias`, `:3493-3531`); that preset keeps its full name. System presets'
  aliases hold no printers. Presets load in folder order (`:1449`).
- The Plater list shows `Preset::label`, the alias when there is one (`:757-761`;
  `PlaterPresetComboBox::get_preset_name`, `slic3r/GUI/PresetComboBoxes.cpp:1586-1589`). Its
  groups are `std::map`s keyed by that label (`:1717-1729`), so a compatible copy puts the alias
  under "User presets" and all incompatible copies together put it once, greyed out, under
  "Unsupported presets" (`:1851`).
- OrcaSlicer: the same rule for root filaments, without the user-preset test, in 2.3.2
  (`libslic3r/Preset.cpp:3262-3282@v2.3.2`); 2.4+ drops the `is_alias_exist` test
  (`:4481-4507@v2.5.0`).

**The change.**

- `customFilamentAlias` (`compat.ts`) mirrors the alias rule. `markFamilyCopies` groups the
  judged presets by alias and leaves out a preset that would hold a printer an earlier preset
  with that alias holds (Studio gives it no alias). It takes the presets in Studio's load order
  (`studioLoadOrder`): `base/` first (`:1424-1426`), then the type's folder, each in file name
  order (the whole file name, upper-cased, as NTFS lists a folder). Every loaded custom filament
  holds printers, shown or not (`:1568`), so filaments with `"instantiation": "false"` hold them
  too without being members. In OrcaSlicer 2.4+ a left-out preset would be grouped; here it keeps
  its own row (one row more).
- **Caveat: folder order.** `directory_iterator` order is the file system's. On Windows (NTFS)
  it is the name order above, so on Windows data the grouping matches Studio. On macOS (APFS) or
  Linux the order isn't sorted, and Preset Doctor can't know it, so when two copies with one
  alias list the same printer, which of them Studio gives the alias can differ from here (rare:
  "Create filament" copies list one printer each).
- A group with a member whose verdict is `selected`, `all` or `other-printer` has a **usable
  copy**: a copy without a process mismatch first, then in that order. A copy that is only for
  other process presets (`process: 'mismatch'`) is under "Unsupported presets" too until one of
  those is selected (`is_compatible_with_print`, `:3114`), so it is used only when no copy fits,
  with `copyProcess: 'mismatch'`. Each member with a verdict of `printer-not-added`,
  `nozzle-not-added` or `unknown-printers` gets
  `CompatDetail.family = { alias, copy, copyState, copyPrinters?, copyProcess?, copyListed? }`
  (`copyListed`: the copy's "name" when it differs from its file name, which is the name Studio
  uses, `:1455`). A `printer-hidden` member keeps its row: repairing that printer preset is
  something to do. (`other-vendor` can't happen: a custom filament has no vendor.)
- Such a member's finding keeps its R2/R3 rule id but is a note (`status: 'info'`), so the row is
  "OK, with notes", not needing attention. It goes first among the row's findings, so it is the
  row's reason over an R4 note. Title: "A copy for a printer you haven't added" (R3: "A copy for a
  nozzle size you haven't added"). Text: "<Studio> lists your custom filament presets
  "<alias> @…" under one name, "<alias>". This copy is made for <printers>, which you haven't
  added, so it only adds a greyed-out "<alias>" under "Unsupported presets". <source> The copy
  "<copy>" is offered for the printer selected now, so "<alias>" in the list is that copy. Nothing
  to do." (for `other-printer`: "... is offered for <printers>, which you've added; when you
  select it, ..."; with `copyProcess`: "..., but only with other process presets than the
  selected one; when you select one of those, ..."). Reason: `Shown in Studio as "<alias>";
  <the R2/R3 reason>`.
- One scan-level note, `R2_FAMILY_COPIES` (`presetPath` the conf, `info`), titled "Copies of
  presets you already use on your printers": "N filament presets are copies of your custom
  filament presets, made for printers or nozzles you haven't added; each group also has a copy
  for a printer you've added (G groups: <up to 3 aliases>). <Studio> lists each group under one
  name, the part before "@": the copy for the printer you select under "User presets", and all
  the other copies together add that name once more, greyed out, under "Unsupported presets".
  Nothing to do." (That one entry also stands for copies for other added printers and copies
  for other processes.) With OrcaSlicer's group hidden, the end says the other copies don't show
  unless the developer setting is on.
- A member without a usable copy (or a `printer-hidden` one) stays `unsupported`, with
  `CompatDetail.shownAs = { alias, others }` (`others`: the family's other members with an R2/R3
  verdict). Its text adds "In the list, <Studio> shows it as "<alias>", the part of its name
  before "@"" and, with `others`, "; that one greyed-out entry also stands for your other
  copies "<alias> @…" that aren't offered for your printers either", and its reason starts with
  `Shown in Studio as "<alias>";`. Processes never have an alias.
- **UI.** The note is a second banner under the printers line with its own "Show them" (search
  text `compat:copies`: the rows with `compat.family`). **CLI.** It is printed as `Note: ...`
  when filament presets are shown. The fixture gets two copies of "My PETG" (X2D, selected; H2D,
  the copy).
- **Live (read-only, temp copy, Nov 7, 2026).** Account A before: 46 filaments and 1 process
  Unsupported, 4 filaments OK with notes. After: 1 process Unsupported (the H2D-only process), 50
  filaments OK with notes (the 46 copies, in 13 groups, each with a `selected` copy for the X2D),
  and the copies note. Account B: unchanged (no copies). Both still have 18 hidden filaments with
  the same pre-selected high fixes.

---

## 6. Feature 3: OrcaSlicer (step 3)

### 6.1 Roots and detection

**Default root.** `%APPDATA%\OrcaSlicer`, from `wxStandardPaths::GetUserDataDir()` with the app
key `OrcaSlicer` (`slic3r/GUI/GUI_App.cpp:2744, 2779-2783@v2.5.0`).

- The MSIX build uses the same folder (`scripts/msix/AppxManifest.xml:22-31@v2.5.0`).
- Portable installs use a `data_dir` folder next to the exe (`:2763-2776`), and `--datadir`
  overrides both (`:2797-2798`). Users with those reach them through "Change folder…".
- `%LOCALAPPDATA%\OrcaSlicer` holds only the WebView2 cache and is not a root.

**`detectSlicer(fs)`.** The first matching rule wins:

1. If both `BambuStudio.conf` and `OrcaSlicer.conf` exist, return `{ok:false, reason:'both'}`
   with: "This folder holds files from both Bambu Studio and OrcaSlicer. Pick the slicer's own
   folder."
2. If `OrcaSlicer.conf` exists, the slicer is **orca**.
3. If `BambuStudio.conf` exists, it is **bambu**.
4. If `system/OrcaFilamentLibrary.json` or `system/OrcaFilamentLibrary.opc` exists, it is
   **orca**.
5. If `system/BBL.json` exists, it is **bambu**. This rule must come after rule 4, because Orca
   also installs `BBL.json` when Bambu printers are enabled in it.
6. If `user/` exists, it is **bambu**, as today. This is a legacy default, and `evidence` says
   so.
7. Otherwise return `{ok:false, reason:'neither'}`. `scan` turns that into today's `ScanError`
   text, made generic ("doesn't look like a Bambu Studio or OrcaSlicer data folder ...").

### 6.2 `OrcaSlicer.conf`

The format is the same as Studio's: JSON, then `# MD5 checksum <hex>`. The reader cuts at the
last `}`, and the checksum is optional (`libslic3r/AppConfig.cpp:741-774@v2.5.0`). The existing
parser works unchanged. Orca 2.5 writes tabs, while 2.3.2 wrote 4 spaces with CRLF.

| `SlicerConf` field | Orca key | Source |
|---|---|---|
| `syncUserPreset` | `app.sync_user_preset` | `libslic3r/AppConfig.cpp:584-586@v2.5.0` |
| `cloudProviders` | `app.cloud_providers` (`"orca"`, `"orca;bbl"`; 2.5 only) | `:1024-1031, 1836-1856` |
| `showUnsupportedPresets` | `app.show_unsupported_presets` (2.4+, default false) | `:455-456` |
| `presetFolder` | `app.preset_folder` (`""` means `default`) | `libslic3r/PresetBundle.cpp:900-905@v2.5.0` |
| `header` | `header`, e.g. `"OrcaSlicer 2.3.2-rc"`. `app.version` is a Bambu-style number; **don't use it** | |
| `enabledModels` | `models[]` | `libslic3r/AppConfig.cpp:873-880@v2.5.0` |
| `selectedPrinter` | `presets.machine` | `:890-906` |
| `selectedProcess` | `presets.process`, or else `orca_presets[i].process` where `orca_presets[i].machine === presets.machine` (live `presets` has only `machine`) | `:943-949` |

`ScanResult.slicerVersion` is the header with `OrcaSlicer ` stripped. `ORCA.unsupportedGroup`
works like this:

- With a version of 2.4 or later (major.minor, numeric) and `showUnsupportedPresets !== true`,
  it returns `'hidden-by-setting'`.
- With an older version it returns `'shown'`.
- With an unknown version, it returns `'hidden-by-setting'` unless the flag is true. That is the
  safer wording, because it says "may not appear".

### 6.3 System presets

**Which vendors load.**

- Every `system/<V>.json` loads, and in 2.5 also `system/<V>.opc` (`libslic3r/utils.cpp:2050-2058@v2.5.0`).
- `OrcaFilamentLibrary` loads first, and the others go on top
  (`libslic3r/PresetBundle.cpp:3338-3341, 3361-3372, 3473-3478@v2.5.0`).

`ORCA.vendorOrder` therefore returns:

- `json`: `OrcaFilamentLibrary` first, then the other `<V>.json` files sorted
  case-insensitively, each with its `system/<V>/` folder;
- `opc`: every `<V>.opc` with no `<V>.json`;
- `base`: `'OrcaFilamentLibrary'`;
- `required`: `'OrcaFilamentLibrary'` when its `.json` is listed (it plays BBL's part: a
  failed library stops that type's parent check, as BBL does for Bambu). Any other vendor that
  fails is named in `SystemIndexSet.failedVendors`, and the lookup then reports missing parents
  of that type as "could not be checked" (`orca.unchecked`), never as hidden.

If system/ has no vendor at all, that is a `SystemIndexError`, handled as today.

**Merged index.**

- **Duplicate names.** The first part wins (`libslic3r/Preset.cpp:4388-4404@v2.5.0`). Live
  `fdm_filament_common` is in both the library and `Elegoo.json`.
- **System chain walks** (`effectiveValue`, `walk`) look a parent up in the preset's **own vendor
  first, then in the `base` vendor**, and nowhere else. Orca does the same
  (`libslic3r/PresetBundle.cpp:7797-7826@v2.5.0`).
  - So a library `@base` parent of an Elegoo filament resolves.
  - Bambu has no `base`, so its walk stays exactly as today.
- **User presets** resolve against the whole merged index. In 2.5, 720 BBL filaments moved into
  `OrcaFilamentLibrary.json` with their names unchanged.
- **Disabled vendors.** Orca deletes `system/<V>.json` and `system/<V>/` when a vendor is
  turned off (`slic3r/Utils/PresetUpdater.cpp:1051-1094@v2.5.0`). See the R1 hint in §6.4.

**Names.** A preset is named by the `name` inside its file, as in Studio
(`libslic3r/PresetBundle.cpp:8439, 8448-8451@v2.5.0`). `findByStudioName` is reused.

**`renamed_from`.** Each body gets `renamedFrom`, built in two ways:

- The JSON key `renamed_from` is a C-escaped, `;`-separated string, parsed like
  `unescape_strings_cstyle` (`libslic3r/PresetBundle.cpp:8484-8488@v2.5.0`). Live `Custom` files
  have it, for example `"My Generic ABS @MyToolChanger"`.
- When the file has neither `alias` nor `renamed_from`, Orca derives one: the text before the
  first `@`, untrimmed, plus the text after it
  (`libslic3r/PresetBundle.cpp:7934-7943@v2.5.0`). For example, `Bambu PLA Basic @BBL X2D` gets
  `Bambu PLA Basic BBL X2D`.

**`.opc` caches (`packages/core/src/opc.ts`, new).**

Orca 2.5's Windows build ships `<V>.opc` without the JSON (`.github/workflows/build_orca.yml:522-527@v2.5.0`).
Installing one removes `system/<V>.json` and `system/<V>/` (`slic3r/Utils/PresetUpdater.cpp:147-163@v2.5.0`).
So after a first 2.5 launch, `system/` may be `.opc` only.

The format:

- **Header.** 20 bytes: `u32 magic 0x4F52435A, u32 version, u64 size, u32 crc32`, all
  little-endian.
- **Body.** It is not compressed, and the CRC covers the body
  (`libslic3r/PresetCacheFormat.cpp:317-333, 435-470@v2.5.0`).
- **Strings.** Inside the body they are cereal binary strings: a `u64` length, then UTF-8 bytes.

```ts
export interface OpaqueVendor { vendor: string; path: string; readable: boolean }
/** Validates magic, size and CRC; false (readable:false) on any mismatch. */
export function readOpc(bytes: Uint8Array): { ok: true; body: Uint8Array } | { ok: false };
/** True when the body contains <u64 LE length><bytes of s>. */
export function opcHasString(body: Uint8Array, s: string): boolean;
```

How a scan uses it:

- **Existence.** A parent counts as present if it is in a JSON index, **or** if `opcHasString` is
  true for any readable `.opc`. In the second case the entry is `{ opaque: true, inherits: '' }`.
  A false "present" is impossible to rule out, because the name could appear only as another
  preset's `inherits` value. That is accepted: it errs toward OK, which is today's rule for
  unreadable bodies.
- **Not found while any `.opc` exists.** That includes an unreadable `.opc`, and an `inherits`
  without `@`, whose derived alias is not stored. R1 then reports **status `info`, severity
  `info`**, "Parent could not be checked":

  > "OrcaSlicer 2.5 keeps its built-in presets in a packed format that Preset Doctor can't read
  > yet, so it can't tell whether "<name>" still exists or suggest a replacement. If this preset
  > is missing in OrcaSlicer, recreate it from a current preset."

  It has no `proposedFix`. The status is **never** `hidden`.
- **R2/R3.** A chain that reaches an opaque entry gives `cant-tell` / `opaque`.
- **No R1 candidates** come from `.opc` vendors.
- **Warning.** One warning per scan, only when an `.opc` exists: "OrcaSlicer's built-in presets
  for <V, ...> are in its packed format; Preset Doctor checks only that parents exist and
  suggests no replacements for them."

### 6.4 Parent lookup (`packages/core/src/orcaLookup.ts`, new)

`find_preset2` with `auto_match` is used by the user loader
(`libslic3r/Preset.cpp:1907-1917@v2.5.0`). It tries these steps
(`libslic3r/Preset.cpp:3894-3931@v2.5.0`; one-step renames in `@v2.3.2:2738-2764`):

1. an exact, case-sensitive name match among instantiated presets (§4.3);
2. `renamed_from` (old name to the preset that lists it), followed **recursively** in 2.5 and
   **one step** when `slicerVersion` is below 2.5;
3. only when the name contains `Generic`, the rewrite
   `^(?:.*?\b(?:\w+_)?)(Generic)\b\s+([^@]+?)\s*(?:@.*)?$` to `Generic $2 @System`, followed by
   steps 1-2 again;

   Steps 2 and 3 exist from 2.3.0 (`find_preset2`). Orca 2.2 and earlier look the parent up by
   its exact name only (`libslic3r/Preset.cpp:1146@v2.2.0`), so for a `slicerVersion` below 2.3
   only step 1 (and step 4, which is 2.5-only anyway) applies. An unknown version gets all steps.
4. **bundles (2.5):** names `_local/<id>/<bare>` and `_subscribed/<id>/<bare>`
   (`libslic3r/Preset.cpp:106-131@v2.5.0`) exist when
   `user/<acct>/<_local|_subscribed>/<id>/<type>/[base/]<bare>.json` exists. Bundles load before
   plain presets (`libslic3r/PresetBundle.cpp:1445-1520@v2.5.0`). No other check is made.

```ts
export type ParentResolution =
  | { via: 'exact'; entry: SystemEntry }
  | { via: 'renamed'; entry: SystemEntry; chain: string[] }
  | { via: 'generic'; entry: SystemEntry; rewritten: string }
  | { via: 'opc'; vendor: string }
  | { via: 'bundle'; path: string };
export function orcaParentLookup(system: SystemIndex, set: SystemIndexSet, fs: PresetFs, accountId: string,
  presets: readonly UserPreset[], type: PresetType):
  Promise<{ get(name: string): SystemEntry | undefined; resolution(name: string): ParentResolution | undefined }>;
```

For a bundle the lookup returns a synthetic root entry, `opaque: true`.

**R1 with Orca** (`rules/r1.ts` reads `ctx.resolve.system.resolution`):

- **`renamed`** gives R1 **`info`/`info`**, "Parent found under its new name":

  > "This preset names "<old>", which OrcaSlicer now calls "<new>". OrcaSlicer finds it
  > anyway. Switching the parent to the new name makes that permanent, and lets the preset load
  > in Bambu Studio too."

  `proposedFix` is `setInherits` with one high candidate, **not pre-selected**.
- **`generic`** gives R1 **`info`/`info`**, "OrcaSlicer substitutes a generic parent":

  > "...so it loads, but on top of "<Generic X @System>"'s settings, not the preset it was made
  > from."

  The candidates are the normal filament ranking, and **nothing is pre-selected**.
- **`opc`** and **`bundle`** produce no finding.
- **Not found** in JSON-only mode (no `.opc`) is an orphan, exactly as for Bambu, with the same
  ranking.

The Orca pool covers instantiated system presets of all vendors plus `base/` user presets (§4.5).
Orca's own history adds two cases to the high tier, and the existing tiers already cover both:

- case-only renames, such as `Elegoo PETG Pro @System` becoming `... PRO @System` in 2.4.0
  without a `renamed_from`;
- suffix toggles, such as `Bambu PLA Basic @BBL X2D` becoming `... 0.4 nozzle` in 2.5.0.

**Vendor-not-installed hint (Orca only).** This applies when the missing name's tag starts with a
word that is neither an installed vendor id nor the tag of any installed preset. An example is
`@Creality`, when `system/Creality.json` is gone.

- R1 adds: "It may come from a printer brand that is turned off in OrcaSlicer. If you turned off
  the <word> printers, turn them back on in OrcaSlicer's printer selection, and this preset will
  come back by itself."
- **Nothing is pre-selected**, even when a single high candidate exists.
- Reading `<exe>\resources\profiles` to confirm is deferred (§11), because it would mean reading
  Program Files.

### 6.5 User folder

- `accounts`:
  - the folders under `user/`, where `hints.cereal` is a file and is skipped by the existing
    `kind === 'dir'` filter;
  - the ids are strings, for example `default`, a Bambu id (up to 2.4) or an Orca Cloud id (2.5,
    `slic3r/GUI/GUI_App.cpp:6057-6071@v2.5.0`);
  - the default pick is the same rule as Bambu.
- The account's `_local/` and `_subscribed/` folders are **not scanned or fixed** in v0.2. They
  are used only as parents (§6.4), and they are always in the backup.
- `user_backup-v<ver>/` folders are siblings of `user/`. Orca copies them once per version and
  never reads them (`libslic3r/PresetBundle.cpp:1047-1068@v2.5.0`). They are not scanned and not
  backed up. The FAQ mentions them.
- The `.info` format is identical to Studio's (`libslic3r/Preset.cpp:701-760@v2.5.0`). Orca
  doesn't stamp `updated_time` on load, and that changes nothing here.
- Orca has no "newer major version" skip, so no rule depends on it.

### 6.6 Slicer running check

- **Process names.** `ORCA.processNames` is `['orca-slicer', 'OrcaSlicer']`. The first is the
  real exe name (`src/CMakeLists.txt:223-229@v2.5.0`, `AppxManifest.xml:43`). The second is
  defensive: a false positive only refuses a write.
- **Lock files.** `user.lock` and `OrcaSlicer.conf.lock` are short-lived OS locks
  (`libslic3r/InstanceLock.hpp:9-22@v2.5.0`). They are not a running signal. Never create or open
  them.
- **Core.** `node/studioProcess.ts` gains this; `isStudioRunning()` becomes
  `isSlicerRunning(BAMBU)`:

  ```ts
  export function isSlicerRunning(profile: SlicerProfile, options?: StudioProcessOptions): Promise<boolean>;
  export interface DefaultPaths { studioRoot: string; orcaRoot: string; backupsDir: string }
  ```

- **Desktop service.** `requireStudioClosed(root)` checks the profile detected for `root`. If
  detection fails, both slicers are checked.
- **Refusal text.** The refusal message names the slicer. The error codes stay `studio-running`
  and `studio-unknown`.
- **Test mode.** The fake-running override is honored only when `PRESET_DOCTOR_ROOT` is neither
  `studioRoot` nor `orcaRoot`.

### 6.7 Cloud sync (R5) for Orca

- **Trigger.** It is the same as for Studio: `syncUserPreset === true`.
- **Algorithm.** The same as Studio §10.3:
  - `need_sync` (`libslic3r/Preset.cpp:2479-2486@v2.5.0`);
  - the upload filter (`:2489-2502`);
  - a cloud copy is applied only if it is newer (`:2636-2652`);
  - a cloud copy whose parent is missing is skipped (`:2714-2721`).
- **Text.** `ORCA.cloudSyncText` reuses Bambu's text with "OrcaSlicer" in place of "Studio". When
  `cloudProviders` includes `orca` it says "Orca Cloud", and when it includes `bbl` it says
  "Bambu cloud". The Bambu string is unchanged.

### 6.8 Backups and restore (both slicers; step 3)

- **The manifest** gains an optional `slicer: SlicerId`. `formatVersion` stays 1, and a missing
  field means `'bambu'`. `BackupInfo.slicer` is always filled in.
- **Restoring into another slicer's folder** throws `BackupSlicerError`. The UI receives it as the
  new `IpcErrorCode 'other-slicer'`, which can't be overridden; `allowOtherSource` doesn't apply.
- **Order.** `restoreBackup` writes every `X.json` before its `X.info`. If writing the `.json`
  fails, its `.info` is not written.
- **Lone `.info` files** (Orca only, since `profile.loneInfoIsCloudDelete` is true there).
  - A backed-up `X.info` is **skipped** when `X.json` is neither in the backup nor on disk now.
  - The paths go into `RestoreResult.skipped: string[]`.
  - The UI and CLI say "n sync files were not put back because their presets are gone, and
    restoring them alone could make OrcaSlicer delete those presets from your cloud."
- **The backups list** shows each backup's slicer. The dialog lists only backups for the current
  slicer by default, with a "Show all" toggle.

### 6.9 Step 3 as built: deviations and choices

Where the code differs from §6.1 to §6.8, §7 and §8, this list is the contract.

- **Texts are reworded, not duplicated.** The rule texts stay written for Bambu Studio.
  `SlicerProfile.reword(text)` turns them into OrcaSlicer's ("Bambu Studio" and "Studio" become
  "OrcaSlicer", "Bambu's current" becomes "OrcaSlicer's current"), and never changes a
  double-quoted part, so a preset named "Bambu Studio PLA" stays as it is. `scan` rewords R1, R4
  and the warnings; `fix.ts` rewords change descriptions. `BAMBU.reword` returns the text
  unchanged, which keeps Bambu output byte-identical. `shortName` is used only where R2/R3
  already used it.
- **Found under another name.** `SystemEntry.currentName` holds the name Orca actually loads when
  a parent was found through `renamed_from` or the "Generic" fallback, so R2/R3's "inherited
  from" names the preset that exists.
- **Brand Off fixture row.** The §8 example `Generic PLA @Creality K1` contains "Generic", so
  Orca's fallback (§6.4 step 3) finds `Generic PLA @System` and the preset is not hidden. The row
  uses `Creality Hyper PLA @Creality K1` instead; it is hidden with the vendor hint, as §8 meant.
- **Library Gone fixture row (added).** `Panchroma PLA Stain @System` names a library preset that
  doesn't exist: hidden, with no candidates and no vendor hint (`System` is an installed tag).
- **Name parsing is unchanged.** `parsePresetName` doesn't split one-word tags such as `@System`
  or `@ECC`, so Orca filament candidates come only from the exact and case-only tiers, and
  Generic Fallback lists none. Changing the parser would change Bambu results, which §2.3
  forbids.
- **Vendor plan.** `ORCA.vendorOrder` loads every `system/<V>.json` (library first, then the rest
  sorted without regard to case), whether or not `system/<V>/` exists. A `.opc` with a matching
  `.json` is ignored; the `.json` wins.
- **Fixture names.** `ORCA_FIXTURE_NAMES = ['orca']` is separate from `FIXTURE_NAMES`, so the
  Bambu round-trip tests keep their list. The fixture's README is
  `__fixtures__/README-orca.md`, written by `scripts/make-orca-fixture.ts`.
- **Desktop test mode.** With `PRESET_DOCTOR_ROOT` set, the slicer switch offers only the folders
  named by `PRESET_DOCTOR_BAMBU_ROOT` and `PRESET_DOCTOR_ORCA_ROOT` (none by default), so a test or
  a copy never shows or opens a real folder. Without `PRESET_DOCTOR_ROOT`, both default roots are
  offered, and the app starts on OrcaSlicer's when Bambu Studio's doesn't exist.
- **Which slicer to check before a write.** The desktop service detects the slicer from the
  folder's files at the time of the write, then falls back to the last scan's. Unknown: both
  slicers must be closed, and the refusal names "Bambu Studio or OrcaSlicer".
- **Web.** `AppConfig.slicers` is `[]`. Before a folder is picked, the guide has its own
  **Bambu Studio | OrcaSlicer** switch for its steps. `checkCopy` uses `detectSlicer`; a folder it
  can't place gets the Bambu Studio message plus one sentence for OrcaSlicer. Restore detects the
  slicer from the copy's files, so a Bambu backup is refused once the copy holds OrcaSlicer's.
- **UI.** A React context (`packages/ui/src/slicerContext.ts`) carries the slicer of the folder on
  screen to every component; for Bambu Studio every text is as before. The backups dialog shows
  other-slicer backups only after "Show all backups", with **Restore** disabled for them.
- **Articles.** `slicerFolder(id)` writes "a Bambu Studio folder" and "an OrcaSlicer folder" in
  the CLI mismatch error and in `BackupSlicerError`.
- **Live check.** The guarded live test copies only `OrcaSlicer.conf`, `system` and `user` into
  `os.tmpdir()` and pins this machine's state (2.3.2-rc, no presets, no warnings).
---

## 7. Contract and app changes

### 7.1 `packages/ui/src/contract.ts`

| Step | Change |
|---|---|
| S1 | Only the types that come through from core change (`PresetSummary.type`, and so on). |
| S2 | Only the types that come through change (`compat`, `'unsupported'`). |
| S3 | `AppConfig.slicers: { id: SlicerId; displayName: string; root: string; exists: boolean }[]`. `root` and `rootExists` stay: they are the folder to scan first, Bambu when it exists, otherwise Orca. Add `IpcErrorCode 'other-slicer'`. `RestorePayload` gets `skipped` through `RestoreResult`. `studioStatus()` keeps its signature and reports the slicer of the root the UI shows: the one last asked to be scanned (even when that scan failed) or picked (the UI reads `scan.slicer` for the label). Showing another root drops every backup session, because only the shown root's slicer is watched. |

No new IPC channel is needed. `scan(root)` with the other slicer's root is the slicer switch.
That root must be on the desktop allow-list, which now holds both default roots.

### 7.2 Desktop (`apps/desktop`, step 3)

- **Constants.** `WINDOW_TITLE` becomes `'Preset Doctor for Bambu Studio and OrcaSlicer'`.
- **`config.ts`.** It returns both default roots. `PRESET_DOCTOR_ROOT` still names one folder of
  either slicer, and detection decides which.
- **`service.ts`:**
  - `adoptFolder` also climbs out of `user/` or `system/` when the parent holds `OrcaSlicer.conf`;
  - `getConfig` fills `slicers`;
  - the slicer check is per root (§6.6).
- **Header.** When `slicers.filter(s => s.exists).length === 2`, the header shows a segmented
  **"Bambu Studio | OrcaSlicer"** switch above the folder field. Switching scans that root. With
  one slicer, it shows a plain label.
- **Labels.** The folder label is "<displayName> folder". `StudioPill` texts use the scan's
  slicer.

### 7.3 Web (`apps/web`, step 3)

- **Detection.** `looksLikeStudio` becomes `detectSlicer` on the picked folder. `adoptFolder`
  also accepts an inner folder named `OrcaSlicer`.
- **`checkCopy` messages** come from the profile:
  - Orca's list is `system`, `user` and `OrcaSlicer.conf`, from `%APPDATA%\OrcaSlicer`;
  - the `system/BBL.json` requirement becomes "a `system` folder with at least one vendor
    `.json` or `.opc`".
- **Guides.** `WebGuide` and `CopyBack` take the slicer and show its folder and conf name. The
  copy-out step for Orca never mentions `orca_refresh_token.sec`, `printers/` or
  `user_backup-*`. The guide says to copy only those three items.
- **Checkbox.** The confirmation reads "I've closed <displayName>".

### 7.4 CLI (step 3)

- **`--slicer bambu|orca`** picks the default folder (`%APPDATA%\BambuStudio` or
  `%APPDATA%\OrcaSlicer`). When a folder is given and detection disagrees, the CLI prints a usage
  error and exits 2.
- **`printHeader`** adds `Slicer:  OrcaSlicer 2.3.2-rc` only for Orca, so Bambu output stays
  byte-identical.
- **Help and branding.** The help text and branding are updated as described in §9.

---

## 8. Fixture: `__fixtures__/orca/` (step 3)

`scripts/make-orca-fixture.ts` (new) **reads `%APPDATA%\OrcaSlicer` only** and refuses to write
inside it, the same guard as `make-fixtures.ts`.

- **System side:**
  - `system/OrcaFilamentLibrary.json`, `Custom.json` and `Elegoo.json`, trimmed to the
    entries used, each in its original list order;
  - the listed files copied byte-for-byte, with their full `inherits` and `include` chains,
    cross-vendor parents included.

  These are public profile files. The live versions are `02.03.02.50`.
- **`OrcaSlicer.conf`** is **synthesized** with only these keys and an MD5 trailer:
  - `header: "OrcaSlicer 2.3.2-rc"`;
  - `app: { preset_folder: "", sync_user_preset: false }`;
  - `models: [{vendor:"Elegoo", model:"Elegoo Centauri Carbon", nozzle_diameter:"0.4;0.6"}]`;
  - `presets: { machine: "Elegoo Centauri Carbon 0.4 nozzle" }`;
  - `orca_presets: [{ machine: "Elegoo Centauri Carbon 0.4 nozzle", process: "0.20mm Standard @Elegoo CC 0.4 nozzle" }]`.

  It contains no paths, uuids or names.
- **User presets** are synthesized (live Orca has none), with ids `default` and `1000000001`:

| File | `inherits` | Expected |
|---|---|---|
| `user/default/filament/Lib Child.json` | `Generic PLA @System` (library) | ok (cross-vendor) |
| `user/default/filament/Renamed.json` | `My Generic ABS @MyToolChanger` | R1 info "new name", candidate `Generic ABS @MyToolChanger`, not pre-selected |
| `user/default/filament/Generic Fallback.json` | `Generic PLA @Elegoo Nonexistent` | R1 info "generic parent" (`Generic PLA @System`), nothing pre-selected |
| `user/default/filament/Case Only.json` | an existing Elegoo name with changed case | R1 hidden, high, pre-selected |
| `user/default/filament/Brand Off.json` | `Generic PLA @Creality K1` (no Creality vendor) | R1 hidden plus the vendor-not-installed hint; nothing pre-selected |
| `user/default/process/CC Copy.json` | `0.20mm Standard @Elegoo CC 0.4 nozzle` | ok, `selected` |
| `user/default/process/CC 06 Copy.json` | `0.30mm Standard @Elegoo CC 0.6 nozzle` | `other-printer` (CC 0.6 is enabled but not selected), counted in the R3 note |
| `user/default/machine/My CC.json` | `Elegoo Centauri Carbon 0.4 nozzle` | ok |
| `user/1000000001/filament/Plain.json` | `Generic PETG @System` | ok (second account; ids are strings) |
| `user/default/filament/Lone.info` with no `Lone.json`, `setting_id` set, `sync_info = delete` | n/a | not a row; included in backup; skipped by restore when the `.json` is absent (§6.8) |

The `.opc` and bundle cases are **memFs unit tests**, not fixture folders:

- a generated valid `.opc` with known strings;
- a corrupted CRC;
- a `.opc`-only `system/`;
- a `_local/abc/filament/X.json` bundle parent.

Detection tests cover all seven rules in §6.1.

**Privacy check, for every generator.** It fails when the output contains any of these:

- the real account ids;
- the user's names or email;
- any live `setting_id` or `user_id` from a user sidecar;
- `slicer_uuid`, `access_code`, `download_path` or `last_backup_path` values.

The list of forbidden strings is read from the live folder at run time and never written to the
repo.

---

## 9. Implementation order and file ownership

Each step starts from the previous step's green `main` working tree. **"Owns"** means the step
creates the file or makes the substantive change to it. **"Touches"** means small, listed edits
only.

### Step 1: preset types and the slicer seam

- **Owns:**
  - in `packages/core/src/`: `slicer.ts`, `terms.ts`, `rules/r1Process.ts`, `rules/r1Machine.ts`;
  - the step 1 changes to `types.ts`, `userScan.ts`, `systemIndex.ts`, `names.ts`,
    `rules/context.ts`, `rules/r1.ts`, `rules/r4.ts`, `scan.ts`, `fix.ts`, `cli.ts` and
    `index.ts`;
  - `testing/fixtures.ts` (add `types-bambu`), `__fixtures__/types-bambu/**`, the
    `__fixtures__/README.md` section, and the `scripts/make-fixtures.ts` builder;
  - in `packages/ui/src/`: `model.ts` (tabs and counts), `components/FindingsTable.tsx` (tabs and
    base tag), `components/DetailPanel.tsx` (candidate printers), `App.tsx` and `styles.css`.
- **Touches:** `SPEC.md` (§3 Scope row, §4 layout, §5 R1/R4 per type) and `CHANGELOG.md`
  (Unreleased: Added process and printer presets; Fixed non-instantiable parents).
- **Done when:**
  - every existing test passes, changed only by added fields (§2.3);
  - the `types-bambu` expectations in §4.10 pass;
  - a read-only CLI scan of a temp copy of the live folder lists 10 process rows for account A,
    all `ok`.

### Step 2: R2/R3

- **Owns:**
  - in `packages/core/src/`: `compat.ts`, `rules/r2r3.ts`, the `conf.ts` fields in §5.2, the R2/R3
    pass in `scan.ts`, the status and rule ids in `types.ts`, and the CLI group in `cli.ts`;
  - `__fixtures__/unsupported-bambu/**` and its builder;
  - in `packages/ui/src/`: `components/PrintersStrip.tsx`, `components/Badges.tsx`, and the step 2
    parts of `model.ts`, `DetailPanel.tsx`, `FindingsTable.tsx` and `App.tsx`;
  - `docs/real-test-checklist.md`, a new section (§10).
- **Touches:** `SPEC.md` (§5: R2/R3 move from "Later" to rules, with the text of §5.3, and §10:
  add the source findings of §5.1), `README.md` ("What it does" and the FAQ entry "Why is my
  preset under Unsupported?") and `CHANGELOG.md`.
- **Done when:**
  - the old fixtures still give `compat.checked === false` and are otherwise unchanged;
  - the `unsupported-bambu` expectations pass;
  - a temp copy of the live folder gives, for account A, 46 filaments with R2 and 1 process with
    R2 (`0.16mm ... H2D`), with no R3. Account B's processes are all in the R3 note.

### Step 3: OrcaSlicer

- **Owns:**
  - in `packages/core/src/`: the `ORCA` profile and detection in `slicer.ts`, `orcaLookup.ts`,
    `opc.ts`, the Orca keys in `conf.ts`, the vendor plan and the `base` walk in
    `systemIndex.ts`, and the step 3 parts of `scan.ts`, `rules/r1.ts`, `compat.ts`,
    `backup.ts`, `node/studioProcess.ts` and `cli.ts`;
  - `scripts/make-orca-fixture.ts` and `__fixtures__/orca/**`;
  - `apps/desktop/src/main/{config,service}.ts`, `apps/desktop/src/shared/constants.ts`, and the
    desktop e2e for the switch;
  - `apps/web/src/browserDoctor.ts` and its guide components;
  - in `packages/ui/src/`: the S3 rows of `contract.ts`, `components/Header.tsx`,
    `BackupsDialog.tsx` and `App.tsx`.
- **Touches:**
  - **Branding:**
    - "Preset Doctor for Bambu Studio and OrcaSlicer" in the window title, the README H1 subtitle,
      the CLI help's first line, the web `<title>` and the header tagline ("Brings back presets
      that Bambu Studio or OrcaSlicer lost track of");
    - the product name stays "Preset Doctor";
    - the disclaimer becomes "Not affiliated with Bambu Lab or the OrcaSlicer project".
  - **`README.md`:** the intro, a "Which slicers" line, Download and Web steps for Orca, the FAQ
    ("OrcaSlicer 2.5 packed presets", "What are user_backup folders?") and the Command line
    section (`--slicer`, `--type`).
  - **`SPEC.md`:** the §3 Slicers row, the §4 Orca layout, the §6 lone-`.info` rule, and a new §11
    "OrcaSlicer source findings" holding the cited facts from §6.
  - **App READMEs:** `apps/desktop/README.md` and `apps/web/README.md`.
  - **`CHANGELOG.md`.**
- **Done when:**
  - every earlier test passes;
  - the Orca fixture's expectations, the `.opc` and bundle unit tests and the restore lone-info
    test pass;
  - the desktop e2e switches slicers on two temp roots;
  - a read-only scan of a temp copy of the live `%APPDATA%\OrcaSlicer` gives 0 presets, no error,
    and `slicerVersion` 2.3.2-rc.

Across all steps, never edit another step's fixture expectations without updating this document.
Every scan of live data runs on a **copy in `os.tmpdir()`**.

---

## 10. Additions to `docs/real-test-checklist.md` (step 2; Orca part in step 3)

1. **R2, process.** Select the X2D in Studio. The H2D-based user process should not be in the
   process list, under either tab. Note whether the plater sidebar and the Process tab behave the
   same way. That settles the medium-confidence claim in §5.1.
2. **R2, filament.** An R2 filament should be under "Unsupported presets" (greyed) on every added
   printer. Add the H2D in Studio, and it becomes normal. Record the exact menu wording ("printer
   selection") for §5.5.
3. **R3 nozzle.** Remove the 0.8 nozzle from X2D in Studio. The X2D 0.8 process should drop out
   of every list, and Preset Doctor should show R3.
4. **Orca 2.3.2.** Repeat check 2 in Orca. The group is always shown there.
5. **Orca 2.4 or later**, if upgraded. Check that the group is missing until Preferences >
   Developer > "Show unsupported presets" is on.
6. **Orca 2.5 `.opc`.** After the upgrade, scan. The expected result is the "could not be checked"
   notes and the warning, never "Hidden".

---

## 11. Deferred or open (not in v0.2)

- R4 checks for a missing `version` key, a newer major version (Studio only), and a file name
  equal to a system name ("already present"). The loader facts are in §4.1.
- `resolve.ts`: model top-level-to-top-level and `base/`-to-user chains as hidden (SPEC §10 q2
  follow-up). This applies to every type.
- A full `.opc` reader for R1 candidates and R2/R3 under Orca 2.5. It needs a skipper for each
  option type (`libslic3r/PresetCacheFormat.cpp:202-310@v2.5.0`).
- Orca vendor-not-installed confirmation from `<exe>\resources\profiles`.
- Scanning and fixing Orca bundle presets (`_local`, `_subscribed`).
- Studio's multi-diameter mode, `compatible_printers_condition` evaluation, and Orca's
  library-alias exclusion (`m_excluded_from`, `libslic3r/Preset.cpp:947-955, 4432-4464@v2.5.0`).
  That exclusion affects only system presets.
- macOS and Linux roots for Orca (`~/Library/Application Support/OrcaSlicer`,
  `~/.config/OrcaSlicer`). Add them to `defaultPaths` only when someone asks.
