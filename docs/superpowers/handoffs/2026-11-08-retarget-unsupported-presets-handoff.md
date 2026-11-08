# Session Handoff: Retarget Unsupported Presets to Installed Printer

**Date:** 2026-11-08  
**Feature:** Retarget Unsupported (R2) Presets to an Installed Printer  
**Repository:** `starting-point` (`smehl86/preset-doctor`) at `/Users/greglawrence/Projects/starting-point`  
**User Context:** macOS arm64, owns Bambu Lab P1S (does not own X1 Carbon).  

---

## 1. Executive Summary & Context

### What Has Already Been Done (Completed & Verified)
1. **macOS Support Implemented & Tested:**
   - Added native macOS menu bar, dock activation, and window management in `apps/desktop/src/main/index.ts`.
   - Added `mac` and `dmg` targets (arm64 & x64) to `apps/desktop/electron-builder.yml`.
   - Packaged and ran `Preset Doctor.app` successfully on the user's Mac.
   - All 1,568 tests passed, lint & format clean.
   - Pushed to `Chewieez/preset-doctor` branch `feat/macos-support` and submitted upstream PR:
     - **PR Link:** [https://github.com/smehl86/preset-doctor/pull/1](https://github.com/smehl86/preset-doctor/pull/1)
2. **Feature Research & Design Spec Completed:**
   - Inspected user's real preset directory at `~/Library/Application Support/BambuStudio/user/3621974899/filament/`.
   - Identified that older Bambu Studio versions defaulted custom presets to inherit from `@BBL X1C` (X1 Carbon).
   - In Bambu Studio, presets inheriting from `@BBL X1C` only have `compatible_printers` for X1C/X1E. On a P1S-only machine, Studio marks them as **Unsupported (Rule R2)**.
   - User previously manually fixed presets by editing `inherits` in the JSON to point to the P1S system preset (`Bambu PLA Basic @BBL P1S 0.4 nozzle`).
   - Created Design Spec: [`docs/superpowers/specs/2026-11-08-retarget-unsupported-presets-design.md`](file:///Users/greglawrence/Projects/starting-point/docs/superpowers/specs/2026-11-08-retarget-unsupported-presets-design.md).
   - Created Implementation Plan: [`docs/superpowers/plans/2026-11-08-retarget-unsupported-presets.md`](file:///Users/greglawrence/Projects/starting-point/docs/superpowers/plans/2026-11-08-retarget-unsupported-presets.md).

---

## 2. Key Architecture & Why It Works

### The Resolution Mechanism
- In Bambu Studio, preset compatibility is resolved by checking `compatible_printers`.
- If a custom preset does not define its own `compatible_printers`, it inherits `compatible_printers` from its parent (`inherits`).
- Retargeting `inherits` from an uninstalled parent (e.g. `Bambu PLA Basic @BBL X1C`) to the installed equivalent (e.g. `Bambu PLA Basic @BBL P1S 0.4 nozzle`):
  1. Grants the custom preset the correct `compatible_printers: ["Bambu Lab P1S 0.4 nozzle"]`.
  2. Studio immediately displays the preset under the user's P1S printer.
  3. Uses genuine system preset tuning for the P1S without modifying vendor files or risking overrides on Studio updates.
  4. Keeps preset file names and IDs stable, preventing R4 name mismatches, cloud sync collisions, or breaking presets that inherit from this preset.

---

## 3. Implementation Plan Overview

The implementation is broken down into 6 bite-sized tasks in [`docs/superpowers/plans/2026-11-08-retarget-unsupported-presets.md`](file:///Users/greglawrence/Projects/starting-point/docs/superpowers/plans/2026-11-08-retarget-unsupported-presets.md):

- **Task 1: Core Types & Model Extensions** (`packages/core/src/types.ts`)
  - Add `printerModel?: string` and `suggestedName?: string` to `Candidate`.
  - Add `retargetCandidates?: Candidate[]` to `CompatDetail`.
- **Task 2: Retarget Matching Engine** (`packages/core/src/rules/r2Retarget.ts` and `r2Retarget.test.ts`)
  - Implement `findRetargetCandidates` using `system.namesWithStem` and checking `system.effectiveCompatiblePrinters` against `inputs.enabled`.
  - Implement `suggestRetargetName` for optional printer code replacement.
- **Task 3: Integration into Compatibility Finding (R2)** (`packages/core/src/scan.ts` and `packages/core/src/rules/r2r3.ts`)
  - When `compatPass` encounters `printer-not-added` with `inherited` parent, find retarget candidates.
  - When candidates exist, attach `proposedFix: { kind: 'setInherits', candidates }` to the R2 finding.
- **Task 4: Fix Planning Integration** (`packages/core/src/fix.test.ts`)
  - Verify `planFixes` applies the chosen parent to `inherits` and updates the `.info` sidecar `base_id`.
- **Task 5: UI Retarget Integration in DetailPanel** (`packages/ui/src/components/DetailPanel.tsx` and `packages/ui/src/model.test.ts`)
  - Present `Retarget to an added printer` in `DetailPanel` when fixing an unsupported preset.
- **Task 6: End-to-End Verification and Documentation** (`README.md`, integration tests)
  - Verify complete workflow and document the new capability in `README.md`.

---

## 4. Instructions for the Implementing Agent

1. **Working Directory:** `/Users/greglawrence/Projects/starting-point`
2. **Git Branch:**
   Create a new branch for the feature from `feat/macos-support`:
   ```bash
   git checkout -b feat/retarget-unsupported-presets
   ```
3. **Execution Skill:**
   Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement the plan task-by-task.
4. **Testing Rule:**
   - **DO NOT** run the full test suite (`npm test`) on intermediate edits.
   - Run ONLY the targeted test file for the specific task using:
     ```bash
     npm test -- --run <path/to/test.ts>
     ```
   - Only run the full verification once all tasks are complete and ready to commit/PR.
5. **Doctrine Rules:**
   - **Zero emoji anywhere** (code, tests, UI, comments, commit messages).
   - Atomic writes and readback verification must be preserved.
