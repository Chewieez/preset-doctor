import type { CompatInputs } from '../compat.js';
import { parsePresetName, sameNozzle } from '../names.js';
import type { SystemEntry, SystemIndex } from '../systemIndex.js';
import type { Candidate, Confidence, UserPreset } from '../types.js';

/**
 * Suggests an updated preset name if the current name explicitly contains the old printer's tag.
 * E.g. "Bambu PLA Basic @BBL X1C - 60C" -> "Bambu PLA Basic @BBL P1S - 60C".
 * Returns undefined if no printer tag is present in the current name.
 *
 * NOTE: Applying preset file renames on disk during retarget is deliberately deferred
 * to avoid cloud sync edge cases, filename collisions, and sync race conditions in
 * Bambu Studio / Orca Slicer. The suggested name is computed here for reference and
 * future non-destructive rename workflows.
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

  // Check candidates against enabled printer profiles
  for (const candName of candidateNames) {
    if (seenNames.has(candName)) continue;

    const printers = await system.effectiveCompatiblePrinters(candName);
    if (!printers || printers.length === 0) {
      continue;
    }

    const compatibleProfiles = inputs.enabled.filter((p) => p.model && printers.includes(p.name));
    if (compatibleProfiles.length === 0) {
      continue;
    }

    const parsedCand = system.parsed(candName);
    const candNozzle = parsedCand?.nozzle ?? '0.4';

    // Prefer exact nozzle match between candidate preset and enabled printer profile
    const matchedProfile =
      compatibleProfiles.find((p) => sameNozzle(p.nozzle ?? '0.4', candNozzle)) ??
      compatibleProfiles.find((p) => sameNozzle(p.nozzle ?? '0.4', parentNozzle)) ??
      compatibleProfiles[0]!;

    const model = matchedProfile.model;
    if (!model) {
      continue;
    }

    const confidence: Confidence = sameNozzle(candNozzle, parentNozzle) ? 'high' : 'medium';

    const body = typeof system.load === 'function' ? await system.load(candName) : undefined;
    const entry = system.get(candName) as
      (SystemEntry & { setting_id?: string; settingId?: string }) | undefined;
    const settingId = body?.settingId ?? entry?.setting_id ?? entry?.settingId;
    const suggested = suggestRetargetName(preset.fileStem, parentCode, model);

    const candidate: Candidate = {
      name: candName,
      confidence,
      reason: `Switch parent to your added ${model} (${matchedProfile.nozzle ?? '0.4'} mm nozzle)`,
      source: 'system',
      preselected: false,
      printers,
      printerModel: model,
    };
    if (settingId !== undefined) {
      candidate.settingId = settingId;
    }
    if (suggested !== undefined) {
      candidate.suggestedName = suggested;
    }

    candidates.push(candidate);
    seenNames.add(candName);
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

  // Sort candidates so preselected: true and confidence === 'high' rank ahead of medium
  candidates.sort((a, b) => {
    if (a.preselected !== b.preselected) {
      return a.preselected ? -1 : 1;
    }
    const score = (c: Candidate) => (c.confidence === 'high' ? 2 : 1);
    return score(b) - score(a);
  });

  return candidates;
}
