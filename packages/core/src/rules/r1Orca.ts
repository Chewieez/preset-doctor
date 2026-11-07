/**
 * R1 under OrcaSlicer (docs/design-v0.2.md section 6.4). Orca finds some parents that Bambu Studio
 * would call missing (orcaLookup.ts), and some it can't check at all (packed .opc presets):
 *
 * - found under a new name (renamed_from): a note, with the new name as a high candidate that is
 *   not pre-selected; the preset loads either way;
 * - found through the "Generic" fallback: a note; it loads, but on top of the library's generic
 *   preset. The normal candidates are listed, none pre-selected;
 * - not found while .opc vendors exist: "could not be checked", never "hidden", no fix;
 * - not found because the printer brand looks turned off in Orca: the normal finding, plus a hint
 *   to turn it back on, and nothing pre-selected.
 *
 * Texts here are written for OrcaSlicer; the shared R1 texts are reworded before this runs.
 */
import { userInherits } from '../resolve.js';
import type { Finding, UserPreset } from '../types.js';
import type { RuleContext } from './context.js';
import { namedByInfoText, preselectedByInfoText } from './r1Common.js';

const UNCHECKED_TEXT = (name: string): string =>
  `OrcaSlicer 2.5 keeps its built-in presets in a packed format that Preset Doctor can't read ` +
  `yet, so it can't tell whether "${name}" still exists or suggest a replacement. If this preset ` +
  'is missing in OrcaSlicer, recreate it from a current preset.';

/**
 * The finding for a preset whose direct parent Orca finds by a fallback, or null. `orphanOf`
 * builds the normal orphan finding for a missing name (used for the "Generic" case's candidates).
 */
export async function orcaFallbackFinding(
  base: { ruleId: Finding['ruleId']; presetPath: string; presetName: string },
  preset: UserPreset,
  ctx: RuleContext,
  orphanOf: (missing: string) => Promise<Finding>,
): Promise<Finding | null> {
  const orca = ctx.orca;
  if (!orca || !preset.json) return null;
  const inherits = userInherits(preset);
  const res = inherits === '' ? undefined : orca.resolution(inherits);
  if (res?.via === 'renamed') {
    const body = await ctx.system.load(res.entry.name);
    const newName = body?.studioName ?? res.entry.name;
    const candidate = {
      name: newName,
      confidence: 'high' as const,
      reason: `OrcaSlicer's current name for "${inherits}" (it lists the old name as renamed).`,
      preselected: false,
      source: 'system' as const,
      ...(body?.settingId !== undefined ? { settingId: body.settingId } : {}),
    };
    return {
      ...base,
      severity: 'info',
      status: 'info',
      title: 'Parent found under its new name',
      explanation:
        `This preset names "${inherits}", which OrcaSlicer now calls "${newName}". OrcaSlicer ` +
        'finds it anyway. Switching the parent to the new name makes that permanent, and lets the ' +
        'preset load in Bambu Studio too.',
      proposedFix: { kind: 'setInherits', candidates: [candidate] },
    };
  }
  if (res?.via === 'generic') {
    const body = await ctx.system.load(res.entry.name);
    const generic = body?.studioName ?? res.rewritten;
    const orphan = await orphanOf(inherits);
    const finding: Finding = {
      ...base,
      severity: 'info',
      status: 'info',
      title: 'OrcaSlicer substitutes a generic parent',
      explanation:
        `This preset is based on "${inherits}", which no longer exists in OrcaSlicer's system ` +
        `presets. OrcaSlicer falls back to "${generic}" instead, so it loads, but on top of ` +
        `"${generic}"'s settings, not the preset it was made from.` +
        (orphan.proposedFix?.kind === 'setInherits'
          ? ' To base it on a preset for your printer again, pick one below.'
          : ''),
    };
    if (orphan.proposedFix?.kind === 'setInherits') {
      finding.proposedFix = {
        kind: 'setInherits',
        candidates: orphan.proposedFix.candidates.map((c) => ({ ...c, preselected: false })),
      };
    }
    return finding;
  }
  return null;
}

/**
 * Adjusts a finding about a parent that is missing (`missing`, named by `referencedBy`): with
 * .opc vendors it becomes "could not be checked"; a direct orphan whose name looks like a
 * turned-off printer brand gets the hint and loses its pre-selection.
 */
export function orcaMissingFinding(f: Finding, missing: string, ctx: RuleContext): Finding {
  const orca = ctx.orca;
  if (!orca) return f;
  if (orca.unchecked) {
    return {
      ruleId: f.ruleId,
      severity: 'info',
      presetPath: f.presetPath,
      ...(f.presetName !== undefined ? { presetName: f.presetName } : {}),
      status: 'info',
      title: 'Parent could not be checked',
      explanation: UNCHECKED_TEXT(missing),
    };
  }
  if (f.status !== 'hidden' || f.severity !== 'error') return f;
  const brand = turnedOffBrand(missing, ctx);
  if (brand === undefined) return f;
  const out: Finding = {
    ...f,
    explanation:
      `${f.explanation} It may come from a printer brand that is turned off in OrcaSlicer. If ` +
      `you turned off the ${brand} printers, turn them back on in OrcaSlicer's printer selection, ` +
      'and this preset will come back by itself.',
  };
  if (f.proposedFix?.kind === 'setInherits') {
    const candidates = f.proposedFix.candidates.map((c) => ({ ...c, preselected: false }));
    out.proposedFix = { kind: 'setInherits', candidates };
    // The shared texts may say a candidate "is pre-selected" (r1Common's preselectedByInfoText,
    // reworded like the rest); it no longer is.
    const pre = f.proposedFix.candidates.find((c) => c.preselected);
    if (pre) {
      const reword = (t: string): string => (ctx.profile ? ctx.profile.reword(t) : t);
      out.explanation = out.explanation
        .split(reword(preselectedByInfoText(pre)))
        .join(reword(namedByInfoText(pre)));
    }
  }
  return out;
}

/**
 * The first word of the missing name's tag (after "@"), when it is neither an installed vendor
 * nor how any installed preset's tag starts: "@Creality K1" when system/Creality.json is gone.
 */
export function turnedOffBrand(missing: string, ctx: RuleContext): string | undefined {
  const at = missing.lastIndexOf('@');
  if (at < 0 || !ctx.orca) return undefined;
  const word =
    missing
      .slice(at + 1)
      .trim()
      .split(/\s+/)[0] ?? '';
  if (word === '' || /^\d/.test(word)) return undefined;
  const lower = word.toLowerCase();
  if (ctx.orca.vendors.some((v) => v.toLowerCase() === lower)) return undefined;
  for (const name of ctx.system.names()) {
    const i = name.lastIndexOf('@');
    if (i < 0) continue;
    const first =
      name
        .slice(i + 1)
        .trim()
        .split(/\s+/)[0] ?? '';
    if (first.toLowerCase() === lower) return undefined;
  }
  return word;
}
