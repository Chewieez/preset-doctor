# Retarget Unsupported Presets to Installed Printer — Design Specification

**Date:** 2026-11-08  
**Feature:** Retarget Unsupported Presets (R2) to Installed Printer  
**Component:** `@preset-doctor/core`, `@preset-doctor/ui`, `apps/desktop`

---

## 1. Background & Problem

In Bambu Studio (and OrcaSlicer), custom presets (especially filament presets) inherit from vendor system presets. Historically, early versions of Bambu Studio defaulted to basing all presets on the **Bambu Lab X1 Carbon** (`@BBL X1C`), even when the user owned a **P1S**, **P1P**, or **A1**.

A preset inheriting from `Bambu PLA Basic @BBL X1C` inherits the parent's `compatible_printers`:
```json
"compatible_printers": [
    "Bambu Lab X1 Carbon 0.4 nozzle",
    "Bambu Lab X1E 0.4 nozzle",
    "Bambu Lab X1E 0.6 nozzle"
]
```

When a user who only owns a P1S opens Bambu Studio, Studio sees that this preset is only compatible with the X1 Carbon. Studio immediately marks the preset as **Unsupported** and moves it to the "Unsupported presets" group.

### The Limitation in Preset Doctor 0.2.0
Preset Doctor currently treats Rule R2 ("Printer not added") as strictly **report-only / informational**:
> *"Bambu Studio lists it under 'Unsupported presets' (greyed out) because you haven't added Bambu Lab X1 Carbon. To fix: add the X1 printer in Bambu Studio."*

This is unhelpful if the user does not own an X1. Adding the X1 in Bambu Studio only displays the preset when the X1 is selected; as soon as the user switches back to their P1S, the preset disappears from the list again.

---

## 2. Requirements & Goals

1. **Auto-Detection:** For presets flagged as Unsupported (R2) where the parent belongs to an uninstalled printer model (e.g. X1C), detect if the user has other printers of the same vendor installed (e.g. P1S, P1P, A1).
2. **Parent Resolution:** Look up the equivalent system preset for the user's installed printer in the slicer's system preset index (e.g., `Bambu PLA Basic @BBL X1C` → `Bambu PLA Basic @BBL P1S 0.4 nozzle`).
3. **Printer Choice:** If the user has multiple printers installed (e.g., P1S and A1 mini), allow the user to select which installed printer to retarget to.
4. **Name Cleaning (Optional Checkbox):**
   - Default: Leave the preset's display name and file name unchanged (updates `inherits` only).
   - If checked: If the preset name contains the old printer tag (e.g., `@BBL X1C` or `@X1C`), replace it with the new printer tag (e.g., `@BBL P1S`), updating `name`, `filament_settings_id`, and renaming the file.
   - Note: File renaming is deferred in favor of in-place preset updates to preserve cloud sync stability and prevent broken external references.
5. **Safety & Diffs:** Use Preset Doctor's existing atomic write pipeline, byte-for-byte readback verification, and automated pre-write zip backup.

---

## 3. Architecture & Interfaces

### 3.1 Core Types (`packages/core/src/types.ts`)
Add optional metadata to `Candidate`:
```ts
export interface Candidate {
  name: string;
  confidence: Confidence;
  reason: string;
  source: 'system' | 'user';
  settingId?: string;
  preselected?: boolean;
  /** When retargeting an unsupported preset: the printer model this candidate is for. */
  printerModel?: string;
  /** When retargeting: suggested new preset name if the old name had the old printer tag. */
  suggestedName?: string;
}
```

### 3.2 Candidate Resolution (`packages/core/src/rules/r2Retarget.ts`)
Create a new module `r2Retarget.ts`:
```ts
export function findRetargetCandidates(
  preset: UserPreset,
  parentName: string,
  system: SystemIndex,
  inputs: CompatInputs,
): Candidate[]
```
**Algorithm:**
1. Parse `parentName` with `parsePresetName(parentName)`.
   - Extracts `stem` (e.g., `"Bambu PLA Basic"`), `vendorTag` (e.g., `"BBL"`), `printerCode` (e.g., `"X1C"`), and `nozzle` (default `"0.4"`).
2. For each enabled model `m` in `inputs.enabledModels`:
   - Skip if `m.model` matches the parent's printer.
   - For each added nozzle size of that model (from `inputs.enabled`):
     - Query `system` for presets with the same `stem` that match `m.model` and nozzle.
     - Verify candidate's `compatible_printers` contains the enabled printer.
     - If matched, build a `Candidate`:
       - `name`: candidate preset name (e.g., `"Bambu PLA Basic @BBL P1S 0.4 nozzle"`)
       - `confidence`: `'high'` if exact stem match, `'medium'` if fallback
       - `reason`: `Switch parent to your added ${m.model} (${nozzle} mm)`
       - `printerModel`: `m.model`
       - `source`: `'system'`
       - `settingId`: system preset `setting_id`

### 3.3 Rule Integration (`packages/core/src/rules/r2r3.ts`)
In `compatFinding()`:
- If finding state is `'printer-not-added'`, check `detail.source.kind === 'inherited'` and `detail.source.from`.
- Call `findRetargetCandidates(preset, detail.source.from, system, inputs)`.
- If candidates exist:
  - Attach `proposedFix = { kind: 'setInherits', candidates }`.
  - If only 1 installed printer model exists, preselect the candidate.

### 3.4 Fix Application (`packages/core/src/fix.ts`)
- `planFixes` already supports `setInherits`! It generates the diff for `"inherits"`.
- If `choice.rename` is selected and `candidate.suggestedName` is present:
  - Generate changes for `name`, `filament_settings_id`, and file path rename.

### 3.5 UI (`packages/ui`)
- In `DetailPanel.tsx`:
  - When an unsupported preset has `proposedFix.kind === 'setInherits'`:
    - Show candidate list / printer dropdown.
    - Checkbox: `[ ] Also update printer tag in preset name`.
- In `FindingsTable.tsx`:
  - Show "Fixable" badge for unsupported presets with retarget candidates.
