# Retarget Unsupported Presets to Installed Printer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to automatically retarget unsupported presets (flagged as Rule R2 because they inherit from an uninstalled printer like `@BBL X1C`) to an installed printer (such as `Bambu Lab P1S`) by updating `inherits` to the matching system preset.

**Architecture:** A new retargeting engine (`packages/core/src/rules/r2Retarget.ts`) queries the slicer's `SystemIndex` for system presets matching the uninstalled parent's stem and the user's enabled printer models (`inputs.enabled`). During `scan`, when an R2 finding is detected with an inherited printer list, retarget candidates are attached as a `proposedFix: { kind: 'setInherits', candidates }`. The existing atomic fix pipeline in `packages/core/src/fix.ts` applies the update to `inherits` and the `.info` sidecar `base_id`, making the preset immediately available in Bambu Studio for the user's actual printer.

**Tech Stack:** TypeScript, Node.js (v20+), Vitest, React, Electron, `@preset-doctor/core`, `@preset-doctor/ui`.

**Spec:** [`docs/superpowers/specs/2026-11-08-retarget-unsupported-presets-design.md`](file:///Users/greglawrence/Projects/starting-point/docs/superpowers/specs/2026-11-08-retarget-unsupported-presets-design.md)

## Global Constraints

- Zero emoji anywhere (no emoji in UI, code, tests, comments, or commit messages).
- Token by intent; no hardcoded styling.
- All writes must use atomic writes, verify readback, and ensure backup session covers files.
- Presets are updated in-place; files are never deleted or moved on disk to prevent sync loss and broken external references.
- Do not run the full test suite for intermediate task steps; run only the single targeted test file for each task.

---

### Task 1: Core Types & Model Extensions

**Files:**
- Modify: `packages/core/src/types.ts:50-62`
- Modify: `packages/core/src/types.ts:214-255`
- Test: `packages/core/src/rules/r2Retarget.test.ts`

**Interfaces:**
- Consumes: Existing `Candidate`, `CompatDetail` types in `packages/core/src/types.ts`.
- Produces:
  - `Candidate.printerModel?: string`
  - `Candidate.suggestedName?: string`
  - `CompatDetail.retargetCandidates?: Candidate[]`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/rules/r2Retarget.test.ts` with type-level checks:

```ts
import { describe, expect, it } from 'vitest';
import type { Candidate, CompatDetail } from '../types.js';

describe('Retarget types', () => {
  it('supports printerModel and suggestedName on Candidate', () => {
    const candidate: Candidate = {
      name: 'Bambu PLA Basic @BBL P1S 0.4 nozzle',
      confidence: 'high',
      reason: 'Switch parent to your added Bambu Lab P1S (0.4 mm)',
      source: 'system',
      settingId: 'PFUS_001',
      preselected: true,
      printerModel: 'Bambu Lab P1S',
      suggestedName: 'Bambu PLA Basic @BBL P1S - 60C bed temp',
    };
    expect(candidate.printerModel).toBe('Bambu Lab P1S');
    expect(candidate.suggestedName).toBe('Bambu PLA Basic @BBL P1S - 60C bed temp');
  });

  it('supports retargetCandidates on CompatDetail', () => {
    const detail: CompatDetail = {
      state: 'printer-not-added',
      printers: ['Bambu Lab X1 Carbon 0.4 nozzle'],
      source: { kind: 'inherited', from: 'Bambu PLA Basic @BBL X1C' },
      retargetCandidates: [
        {
          name: 'Bambu PLA Basic @BBL P1S 0.4 nozzle',
          confidence: 'high',
          reason: 'Switch parent to your added Bambu Lab P1S (0.4 mm)',
          source: 'system',
          preselected: true,
          printerModel: 'Bambu Lab P1S',
        },
      ],
    };
    expect(detail.retargetCandidates).toHaveLength(1);
    expect(detail.retargetCandidates?.[0]?.printerModel).toBe('Bambu Lab P1S');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run packages/core/src/rules/r2Retarget.test.ts`
Expected: FAIL with TypeScript compilation errors (`printerModel does not exist in type Candidate` or `retargetCandidates does not exist in type CompatDetail`).

- [ ] **Step 3: Update `packages/core/src/types.ts`**

In `packages/core/src/types.ts`:
Add `printerModel?: string;` and `suggestedName?: string;` to `Candidate`:
```ts
export interface Candidate {
  name: string;
  confidence: Confidence;
  settingId?: string;
  reason: string;
  preselected: boolean;
  source?: 'system' | 'user';
  printers?: string[];
  /** When retargeting an unsupported preset: the printer model this candidate is for. */
  printerModel?: string;
  /** When retargeting: suggested new preset name if the old name had the old printer tag. */
  suggestedName?: string;
}
```

Add `retargetCandidates?: Candidate[];` to `CompatDetail`:
```ts
export interface CompatDetail {
  state: CompatState;
  printers: string[];
  source: CompatSource;
  matchedPrinters?: string[];
  unknownNames?: string[];
  guessed?: boolean;
  model?: string;
  nozzles?: string[];
  addedNozzles?: string[];
  hiddenPrinters?: string[];
  vendor?: string;
  process?: 'mismatch' | 'cant-tell';
  why?: 'condition' | 'opaque';
  family?: CompatFamily;
  shownAs?: CompatAlias;
  moreNozzles?: NozzleOffer;
  /** Suggested system preset parents from installed printers for unsupported presets. */
  retargetCandidates?: Candidate[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run packages/core/src/rules/r2Retarget.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/rules/r2Retarget.test.ts
git commit -m "feat(core): add printerModel, suggestedName and retargetCandidates types"
```

---

### Task 2: Retarget Candidate Matching Engine

**Files:**
- Create: `packages/core/src/rules/r2Retarget.ts`
- Modify: `packages/core/src/rules/r2Retarget.test.ts`

**Interfaces:**
- Consumes:
  - `parsePresetName` from `packages/core/src/names.ts`
  - `SystemIndex` from `packages/core/src/systemIndex.ts`
  - `CompatInputs` from `packages/core/src/compat.ts`
  - `UserPreset`, `Candidate` from `packages/core/src/types.ts`
- Produces:
  - `findRetargetCandidates(preset: UserPreset, parentName: string, system: SystemIndex, inputs: CompatInputs): Promise<Candidate[]>`
  - `suggestRetargetName(currentName: string, oldPrinterCode: string | undefined, newPrinterModel: string): string | undefined`

- [ ] **Step 1: Write the failing tests**

Append tests to `packages/core/src/rules/r2Retarget.test.ts`:

```ts
import { findRetargetCandidates, suggestRetargetName } from './r2Retarget.js';
import type { SystemIndex } from '../systemIndex.js';
import type { CompatInputs } from '../compat.js';
import type { UserPreset } from '../types.js';

describe('suggestRetargetName', () => {
  it('replaces old printer tag in preset name with new printer tag', () => {
    expect(
      suggestRetargetName('Bambu PLA Basic @BBL X1C - 60C bed temp', 'X1C', 'Bambu Lab P1S'),
    ).toBe('Bambu PLA Basic @BBL P1S - 60C bed temp');
  });

  it('returns undefined if preset name has no printer tag', () => {
    expect(
      suggestRetargetName('Bambu PLA Basic - PA.025 AF 0%', 'X1C', 'Bambu Lab P1S'),
    ).toBeUndefined();
  });
});

describe('findRetargetCandidates', () => {
  it('finds matching system preset for installed P1S printer when parent was X1C', async () => {
    const mockSystem: Partial<SystemIndex> = {
      namesWithStem: (stem: string) => {
        if (stem.toLowerCase() === 'bambu pla basic') {
          return [
            'Bambu PLA Basic @BBL X1C',
            'Bambu PLA Basic @BBL X1C 0.4 nozzle',
            'Bambu PLA Basic @BBL P1S 0.4 nozzle',
            'Bambu PLA Basic @BBL A1M 0.4 nozzle',
          ];
        }
        return [];
      },
      parsed: (name: string) => ({
        stem: 'Bambu PLA Basic',
        vendorTag: 'BBL',
        printerCode: name.includes('P1S') ? 'P1S' : name.includes('X1C') ? 'X1C' : 'A1M',
        nozzle: '0.4',
      }),
      effectiveCompatiblePrinters: async (name: string) => {
        if (name === 'Bambu PLA Basic @BBL P1S 0.4 nozzle') {
          return ['Bambu Lab P1S 0.4 nozzle'];
        }
        if (name.includes('X1C')) {
          return ['Bambu Lab X1 Carbon 0.4 nozzle'];
        }
        return [];
      },
      get: (name: string) => ({
        name,
        file: `${name}.json`,
        setting_id: name === 'Bambu PLA Basic @BBL P1S 0.4 nozzle' ? 'PFUS_P1S_04' : 'PFUS_X1C_04',
      }),
    };

    const preset: UserPreset = {
      type: 'filament',
      accountId: '12345678',
      path: 'user/12345678/filament/Bambu PLA Basic @BBL X1C - 60C bed temp.json',
      fileStem: 'Bambu PLA Basic @BBL X1C - 60C bed temp',
      isBase: false,
      raw: '{}',
      infoPath: 'user/12345678/filament/Bambu PLA Basic @BBL X1C - 60C bed temp.info',
    };

    const inputs: CompatInputs = {
      enabled: [
        {
          name: 'Bambu Lab P1S 0.4 nozzle',
          model: 'Bambu Lab P1S',
          nozzle: '0.4',
          vendor: 'BBL',
          isUser: false,
        },
      ],
      enabledModels: [{ vendor: 'BBL', model: 'Bambu Lab P1S', nozzles: ['0.4'] }],
      knownPrinters: new Map(),
      vendorCheck: true,
    };

    const candidates = await findRetargetCandidates(
      preset,
      'Bambu PLA Basic @BBL X1C',
      mockSystem as SystemIndex,
      inputs,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.name).toBe('Bambu PLA Basic @BBL P1S 0.4 nozzle');
    expect(candidates[0]?.confidence).toBe('high');
    expect(candidates[0]?.printerModel).toBe('Bambu Lab P1S');
    expect(candidates[0]?.settingId).toBe('PFUS_P1S_04');
    expect(candidates[0]?.preselected).toBe(true);
    expect(candidates[0]?.suggestedName).toBe('Bambu PLA Basic @BBL P1S - 60C bed temp');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run packages/core/src/rules/r2Retarget.test.ts`
Expected: FAIL with "Cannot find module './r2Retarget.js'".

- [ ] **Step 3: Implement `packages/core/src/rules/r2Retarget.ts`**

Write `packages/core/src/rules/r2Retarget.ts`:

```ts
import type { CompatInputs } from '../compat.js';
import { parsePresetName } from '../names.js';
import type { SystemIndex } from '../systemIndex.js';
import type { Candidate, Confidence, UserPreset } from '../types.js';

/**
 * Suggests an updated preset name if the current name explicitly contains the old printer's tag.
 * E.g. "Bambu PLA Basic @BBL X1C - 60C" -> "Bambu PLA Basic @BBL P1S - 60C".
 * Returns undefined if no printer tag is present in the current name.
 */
export function suggestRetargetName(
  currentName: string,
  oldPrinterCode: string | undefined,
  newPrinterModel: string,
): string | undefined {
  if (!oldPrinterCode || !currentName.includes(oldPrinterCode)) {
    return undefined;
  }
  // Determine standard model tag: e.g. "Bambu Lab P1S" -> "P1S"
  const newModelTag = newPrinterModel.replace(/^Bambu Lab\s+/i, '').trim();
  // Replace "@BBL <OLD>" -> "@BBL <NEW>" or "@<OLD>" -> "@<NEW>"
  const bblPattern = new RegExp(`@BBL\\s+${oldPrinterCode}\\b`, 'g');
  if (bblPattern.test(currentName)) {
    return currentName.replace(bblPattern, `@BBL ${newModelTag}`);
  }
  const tagPattern = new RegExp(`@${oldPrinterCode}\\b`, 'g');
  if (tagPattern.test(currentName)) {
    return currentName.replace(tagPattern, `@${newModelTag}`);
  }
  return undefined;
}

/**
 * Finds system preset candidates matching the parent's filament stem and compatible with
 * the user's enabled printers.
 */
export async function findRetargetCandidates(
  preset: UserPreset,
  parentName: string,
  system: SystemIndex,
  inputs: CompatInputs,
): Promise<Candidate[]> {
  const parsedParent = parsePresetName(parentName);
  if (!parsedParent || !parsedParent.stem) {
    return [];
  }

  const stem = parsedParent.stem;
  const parentNozzle = parsedParent.nozzle ?? '0.4';
  const parentCode = parsedParent.printerCode;

  // Search system index for all presets with the same stem
  const candidateNames = system.namesWithStem(stem);
  if (candidateNames.length === 0) {
    return [];
  }

  const candidates: Candidate[] = [];
  const seenNames = new Set<string>();

  // Check against each enabled printer profile
  for (const enabledPrinter of inputs.enabled) {
    for (const candName of candidateNames) {
      if (seenNames.has(candName)) continue;

      const printers = await system.effectiveCompatiblePrinters(candName);
      if (!printers || !printers.includes(enabledPrinter.name)) {
        continue;
      }

      const parsedCand = system.parsed(candName);
      const candNozzle = parsedCand?.nozzle ?? '0.4';
      const confidence: Confidence = candNozzle === parentNozzle ? 'high' : 'medium';

      const entry = system.get(candName);
      const suggested = suggestRetargetName(
        preset.fileStem,
        parentCode,
        enabledPrinter.model,
      );

      candidates.push({
        name: candName,
        confidence,
        reason: `Switch parent to your added ${enabledPrinter.model} (${enabledPrinter.nozzle ?? '0.4'} mm nozzle)`,
        source: 'system',
        settingId: entry?.setting_id,
        preselected: false,
        printers,
        printerModel: enabledPrinter.model,
        suggestedName: suggested,
      });

      seenNames.add(candName);
    }
  }

  // Pre-selection rule: if candidates are all for a single printer model, preselect the best one
  const distinctModels = new Set(candidates.map((c) => c.printerModel).filter(Boolean));
  if (distinctModels.size === 1) {
    const firstHigh = candidates.find((c) => c.confidence === 'high');
    if (firstHigh) {
      firstHigh.preselected = true;
    } else if (candidates.length > 0 && candidates[0]) {
      candidates[0].preselected = true;
    }
  }

  return candidates;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run packages/core/src/rules/r2Retarget.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/rules/r2Retarget.ts packages/core/src/rules/r2Retarget.test.ts
git commit -m "feat(core): implement findRetargetCandidates and suggestRetargetName"
```

---

### Task 3: Integration into Compatibility Finding (R2)

**Files:**
- Modify: `packages/core/src/scan.ts:320-330`
- Modify: `packages/core/src/rules/r2r3.ts:124-142`
- Test: `packages/core/src/scan.test.ts`

**Interfaces:**
- Consumes:
  - `findRetargetCandidates` from `packages/core/src/rules/r2Retarget.ts`
  - `detail.retargetCandidates` on `CompatDetail`
- Produces:
  - R2 findings with `proposedFix: { kind: 'setInherits', candidates: detail.retargetCandidates }` when retarget candidates exist.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/scan.test.ts`, add a test verifying that an unsupported preset with an installed printer gets a `proposedFix`:

```ts
  it('attaches setInherits fix when unsupported preset matches an installed printer', async () => {
    // A simulated scan where user has P1S enabled and a preset inheriting from X1C
    const r = await scan(
      fsWithConfig({
        models: [{ vendor: 'BBL', model: 'Bambu Lab P1S', nozzles: ['0.4'] }],
        userPresets: [
          {
            type: 'filament',
            path: 'user/1000000001/filament/My PLA @BBL X1C.json',
            inherits: 'Bambu PLA Basic @BBL X1C',
          },
        ],
      }),
    );
    const finding = r.findings.find(
      (f) => f.presetPath === 'user/1000000001/filament/My PLA @BBL X1C.json' && f.ruleId === R2_ID,
    );
    expect(finding).toBeDefined();
    expect(finding?.proposedFix).toBeDefined();
    expect(finding?.proposedFix?.kind).toBe('setInherits');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run packages/core/src/scan.test.ts`
Expected: FAIL (because `finding?.proposedFix` is undefined).

- [ ] **Step 3: Modify `packages/core/src/scan.ts` and `packages/core/src/rules/r2r3.ts`**

In `packages/core/src/scan.ts`:
Import `findRetargetCandidates`:
```ts
import { findRetargetCandidates } from './rules/r2Retarget.js';
```
In `compatPass()` around line 326:
```ts
    const detail = judgeCompat(eff, preset.type, inputs);
    if (detail.state === 'printer-not-added' && detail.source.kind === 'inherited' && system) {
      const retarget = await findRetargetCandidates(preset, detail.source.from, system, inputs);
      if (retarget.length > 0) {
        detail.retargetCandidates = retarget;
      }
    }
    details.set(preset, detail);
```

In `packages/core/src/rules/r2r3.ts`:
In `compatFinding()` under `case 'printer-not-added':`:
```ts
    case 'printer-not-added': {
      const also =
        unknownNames.length > 0
          ? ` It also lists printer names ${short} doesn't know (${shortList(quoted(unknownNames), NAMES_SHOWN)}).`
          : '';
      const hasRetarget = detail.retargetCandidates && detail.retargetCandidates.length > 0;
      const advice = hasRetarget
        ? `You can retarget it to one of your added printers below, or add ${known.length === 1 ? 'that printer' : 'one of those printers'} in ${studio}'s printer selection.`
        : `To use it, add ${known.length === 1 ? 'that printer' : 'one of those printers'} in ` +
          `${studio}'s printer selection. If you no longer have ${known.length === 1 ? 'it' : 'them'}, you ` +
          `can ignore this preset or delete it in ${short}.`;

      return {
        ...base,
        ruleId: R2_ID,
        title: "Only for printers you haven't added",
        explanation: join(
          intro,
          `It is made for ${shortList(known, NAMES_SHOWN)}, which you haven't added in ${short}.${also}`,
          source,
          advice,
        ),
        proposedFix: hasRetarget
          ? {
              kind: 'setInherits',
              candidates: detail.retargetCandidates!,
            }
          : undefined,
      };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run packages/core/src/scan.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scan.ts packages/core/src/rules/r2r3.ts packages/core/src/scan.test.ts
git commit -m "feat(core): attach retarget setInherits fix to R2 unsupported preset findings"
```

---

### Task 4: Fix Planning Integration & Verification

**Files:**
- Modify: `packages/core/src/fix.test.ts`
- Modify: `packages/core/src/fix.ts:145-165` (if needed for name updates)

**Interfaces:**
- Consumes: `ScanResult`, `FixChoice` with `candidateName`.
- Produces: `Change[]` diff with updated `inherits` and `.info` sidecar `base_id`.

- [ ] **Step 1: Write test for retargeting in `packages/core/src/fix.test.ts`**

Add test in `packages/core/src/fix.test.ts`:

```ts
  it('plans an R2 retarget fix by updating inherits to the chosen parent and updating base_id', async () => {
    const presetPath = 'user/1000000001/filament/Bambu PLA Basic @BBL X1C - 60C bed temp.json';
    const infoPath = 'user/1000000001/filament/Bambu PLA Basic @BBL X1C - 60C bed temp.info';
    const fs = testFs({
      [presetPath]: JSON.stringify({
        name: 'Bambu PLA Basic @BBL X1C - 60C bed temp',
        inherits: 'Bambu PLA Basic @BBL X1C',
        from: 'user',
      }, null, 2),
      [infoPath]: 'base_id = PFUS_OLD_X1C\nsetting_id = PFUS_USER_001\n',
    });

    const scanResult: ScanResult = {
      root: '',
      userId: '1000000001',
      accounts: [],
      presets: [
        {
          type: 'filament',
          accountId: '1000000001',
          path: presetPath,
          fileStem: 'Bambu PLA Basic @BBL X1C - 60C bed temp',
          name: 'Bambu PLA Basic @BBL X1C - 60C bed temp',
          inherits: 'Bambu PLA Basic @BBL X1C',
          isBase: false,
          status: 'unsupported',
          reason: 'Only for printers you haven\'t added',
          ruleIds: [RULE_IDS.printerNotAdded],
        },
      ],
      findings: [
        {
          ruleId: RULE_IDS.printerNotAdded,
          severity: 'info',
          status: 'unsupported',
          presetPath,
          presetName: 'Bambu PLA Basic @BBL X1C - 60C bed temp',
          presetType: 'filament',
          title: "Only for printers you haven't added",
          explanation: 'It is made for Bambu Lab X1 Carbon.',
          proposedFix: {
            kind: 'setInherits',
            candidates: [
              {
                name: 'Bambu PLA Basic @BBL P1S 0.4 nozzle',
                confidence: 'high',
                reason: 'Switch parent to your added Bambu Lab P1S (0.4 mm)',
                source: 'system',
                settingId: 'PFUS_NEW_P1S',
                preselected: true,
                printerModel: 'Bambu Lab P1S',
              },
            ],
          },
        },
      ],
      warnings: [],
      systemVersion: '02.08.00.06',
      systemIndexRead: true,
      slicer: 'bambu',
      slicerVersion: null,
      countsByType: { filament: 1, process: 0, machine: 0 },
      indexesRead: { filament: true, process: true, machine: true },
      compat: {
        checked: true,
        enabled: [{ vendor: 'BBL', model: 'Bambu Lab P1S', nozzles: ['0.4'] }],
        userPrinters: 0,
        unsupportedGroup: 'shown',
      },
    };

    const changes = await planFixes(fs, scanResult, [
      {
        presetPath,
        candidateName: 'Bambu PLA Basic @BBL P1S 0.4 nozzle',
      },
    ]);

    expect(changes).toHaveLength(2);
    const jsonChange = changes.find((c) => c.path === presetPath);
    expect(jsonChange).toBeDefined();
    expect(jsonChange?.after).toContain('"inherits": "Bambu PLA Basic @BBL P1S 0.4 nozzle"');
    expect(jsonChange?.description).toContain('set its parent to "Bambu PLA Basic @BBL P1S 0.4 nozzle"');

    const infoChange = changes.find((c) => c.path === infoPath);
    expect(infoChange).toBeDefined();
    expect(infoChange?.after).toContain('base_id = PFUS_NEW_P1S');
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- --run packages/core/src/fix.test.ts`
Expected: PASS (verifying existing `planFixes` correctly processes `setInherits` on R2 findings).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/fix.test.ts
git commit -m "test(core): verify planFixes handles R2 retargeting cleanly"
```

---

### Task 5: UI Retarget Integration in DetailPanel

**Files:**
- Modify: `packages/ui/src/components/DetailPanel.tsx:113-148`
- Modify: `packages/ui/src/model.test.ts`
- Test: `packages/ui/src/model.test.ts`

**Interfaces:**
- Consumes: `Candidate.printerModel` and `Finding.ruleId`
- Produces: Clearer legend/labels when retargeting unsupported presets in UI.

- [ ] **Step 1: Write test for UI model handling of R2 retarget candidates**

In `packages/ui/src/model.test.ts`, add test:

```ts
  it('extracts candidates and preselects single-model retarget candidate', () => {
    const findings: Finding[] = [
      {
        ruleId: 'printer-not-added',
        severity: 'info',
        status: 'unsupported',
        presetPath: 'user/default/filament/Old.json',
        title: "Only for printers you haven't added",
        explanation: 'Needs P1S',
        proposedFix: {
          kind: 'setInherits',
          candidates: [
            {
              name: 'New P1S Parent',
              confidence: 'high',
              reason: 'Switch parent to your added Bambu Lab P1S',
              source: 'system',
              preselected: true,
              printerModel: 'Bambu Lab P1S',
            },
          ],
        },
      },
    ];
    const fixes = fixesFor(findings);
    expect(fixes.candidates).toHaveLength(1);
    expect(hasFix(fixes)).toBe(true);
    expect(fixes.candidates?.[0]?.printerModel).toBe('Bambu Lab P1S');
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- --run packages/ui/src/model.test.ts`
Expected: PASS

- [ ] **Step 3: Update `packages/ui/src/components/DetailPanel.tsx`**

In `packages/ui/src/components/DetailPanel.tsx`:
Update legend to adapt when fixing an unsupported preset:
```tsx
        <fieldset className="candidates">
          <legend>
            {preset.status === 'unsupported'
              ? 'Retarget to an added printer'
              : 'Choose the new parent preset'}
          </legend>
          {fixes.candidates.map((c) => (
            <label
              key={c.name}
              className={`candidate ${pick === c.name && checked ? 'chosen' : ''}`}
            >
              <input
                type="radio"
                name={radioName}
                checked={pick === c.name && checked}
                onChange={() => onPick(path, c.name)}
              />
              <span className="candidate-body">
                <span className="candidate-name">
                  {c.name} <ConfidenceBadge confidence={c.confidence} />
                </span>
                <span className="candidate-reason">{c.reason}</span>
                {c.printers && c.printers.length > 0 && <PrinterList printers={c.printers} />}
              </span>
            </label>
          ))}
```

- [ ] **Step 4: Run UI tests to verify everything passes**

Run: `npm test -- --run packages/ui/src/model.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/DetailPanel.tsx packages/ui/src/model.test.ts
git commit -m "feat(ui): display Retarget to an added printer in DetailPanel for unsupported presets"
```

---

### Task 6: End-to-End Verification and Documentation

**Files:**
- Modify: `README.md`
- Test: Full targeted integration tests

- [ ] **Step 1: Document Retargeting feature in `README.md`**

In `README.md` under supported rules and fixes, add note about Rule R2 retargeting:
"Rule R2 (Unsupported Presets): If a custom preset is unsupported because its parent is locked to a printer you don't own (such as early Studio presets locked to `@BBL X1C`), Preset Doctor offers to retarget it to an installed printer (e.g. `@BBL P1S`) with one click."

- [ ] **Step 2: Run targeted verification tests**

Run:
```bash
npm test -- --run packages/core/src/rules/r2Retarget.test.ts packages/core/src/scan.test.ts packages/core/src/fix.test.ts packages/ui/src/model.test.ts
```
Expected: All targeted tests PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document R2 unsupported preset retargeting"
```
