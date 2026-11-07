/**
 * R4 MALFORMED: files Studio can't load, presets without a name, a `name` that differs from
 * the file name, and presets without a `.info` sidecar. Only the name mismatch is fixable.
 */
import { basename } from '../fs.js';
import { presetName, userInherits } from '../resolve.js';
import { TERMS } from '../terms.js';
import { RULE_IDS, type Finding, type UserPreset } from '../types.js';

export const R4_ID = RULE_IDS.malformed;

export interface R4Context {
  /**
   * The scanned account's presets of the same type, to check that a rename can't clash or orphan
   * anyone (names only clash within a type: a process may share a filament's name).
   */
  presets: readonly UserPreset[];
  /** System preset names of that type; a user preset must not be renamed onto one. */
  system?: { has(name: string): boolean };
  /**
   * User preset names that R1 suggests as a new parent, mapped to the orphan suggesting it
   * (see userCandidateNames). Such a preset is not renamed, or the repair would orphan again.
   */
  suggestedParents?: ReadonlyMap<string, string>;
}

/**
 * The file name (without .json) Studio saves a preset under: the name, plus ".json" unless it
 * already ends with that (Studio's path_from_name checks this case-insensitively).
 */
export function studioFileStem(name: string): string {
  return name.toLowerCase().endsWith('.json') ? name.slice(0, -'.json'.length) : name;
}

export function checkR4(preset: UserPreset, ctx: R4Context): Finding[] {
  const base = { ruleId: R4_ID, presetPath: preset.path };

  if (!preset.json) {
    return [
      {
        ...base,
        presetName: preset.fileStem,
        severity: 'error',
        status: 'broken',
        title: 'File is damaged',
        explanation:
          `Studio can't read this file (${preset.parseError ?? 'it is not valid JSON'}). ` +
          'It is usually cut short or edited by hand. Restore it from a backup, or recreate the ' +
          'preset in Bambu Studio.',
      },
    ];
  }

  const findings: Finding[] = [];
  const name = presetName(preset);
  // UserPreset objects made by hand (tests, simulations) may predate the type field.
  const type = preset.type ?? 'filament';
  if (name === undefined) {
    findings.push({
      ...base,
      presetName: preset.fileStem,
      severity: 'error',
      status: 'broken',
      title: 'Preset has no name',
      explanation:
        `The file has no "name" setting, so Studio has nothing to show in the ${TERMS[type].list}. ` +
        'Recreate the preset in Bambu Studio, or restore it from a backup.',
    });
  } else if (studioFileStem(name) !== preset.fileStem) {
    findings.push(nameMismatch(preset, name, ctx));
  }

  if (preset.infoError !== undefined) {
    findings.push({
      ...base,
      presetName: name ?? preset.fileStem,
      severity: 'info',
      status: 'info',
      title: 'Sync file (.info) could not be read',
      explanation: preset.infoIsFolder
        ? `There is a folder named "${basename(preset.infoPath)}" where this preset's sync file ` +
          "should be. Studio can't use it, and scanning again won't change that: move that " +
          `folder out of the ${type} folder, then scan again.`
        : "Preset Doctor couldn't open this preset's sync file. Another program may be holding " +
          'it open: close OneDrive or pause the antivirus scan, then scan again. ' +
          `(Details: ${preset.infoError})`,
    });
  } else if (preset.info === undefined) {
    findings.push({
      ...base,
      presetName: name ?? preset.fileStem,
      severity: 'info',
      status: 'info',
      title: 'No sync file (.info)',
      explanation:
        'There is no .info file next to this preset. That is common and usually harmless: ' +
        'Studio keeps cloud-sync details there and creates it when the preset is synced.',
    });
  }
  return findings;
}

function nameMismatch(preset: UserPreset, name: string, ctx: R4Context): Finding {
  const file = `${preset.fileStem}.json`;
  if (studioFileStem(name).toLowerCase() === preset.fileStem.toLowerCase()) {
    // Windows file names ignore case, so Studio still pairs the two; nothing to repair.
    return {
      ruleId: R4_ID,
      presetPath: preset.path,
      presetName: name,
      severity: 'info',
      status: 'info',
      title: 'Name differs from the file name in capitalization only',
      explanation:
        `The preset is called "${name}" but its file is "${file}". Only upper/lower case ` +
        'differs, which Windows treats as the same name, so this is harmless.',
    };
  }

  const newName = preset.fileStem;
  const finding: Finding = {
    ruleId: R4_ID,
    presetPath: preset.path,
    presetName: name,
    severity: 'warning',
    status: 'info',
    title: "Name doesn't match the file name",
    explanation:
      `The preset is called "${name}" but its file is "${file}". Studio can get confused ` +
      `when the two differ, for example when syncing or saving. Renaming the preset to ` +
      `"${newName}" makes them match.`,
  };

  const blocker = renameBlocker(preset, name, newName, ctx);
  if (blocker) finding.explanation += ` Preset Doctor won't do that automatically: ${blocker}`;
  else finding.proposedFix = { kind: 'renamePreset', newName };
  return finding;
}

function renameBlocker(
  preset: UserPreset,
  oldName: string,
  newName: string,
  ctx: R4Context,
): string | undefined {
  if (ctx.system?.has(newName)) return `a Studio system preset is already called "${newName}".`;
  const other = ctx.presets.find((p) => p !== preset && presetName(p) === newName);
  if (other) return `another of your presets is already called "${newName}".`;
  const child = ctx.presets.find((p) => p !== preset && userInherits(p) === oldName);
  if (child) {
    // Studio knows this preset only by its file name, so that child is already hidden (R1).
    return (
      `your preset "${presetName(child) ?? child.fileStem}" is based on "${oldName}", and Studio ` +
      `knows this preset only by its file name, so that preset is hidden. Fix it first (see its ` +
      `own entry), then rename this one.`
    );
  }
  const orphan = ctx.suggestedParents?.get(oldName);
  if (orphan !== undefined) {
    return `it is a suggested new parent for your preset "${orphan}", which would then be hidden again.`;
  }
  return undefined;
}
