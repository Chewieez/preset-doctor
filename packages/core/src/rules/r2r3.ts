/**
 * R2 and R3: presets the slicer loads but doesn't offer for the printers that are added
 * (verdicts from compat.ts). Report-only: editing compatible_printers would fight Studio's
 * "save only what differs from the parent" model (src/libslic3r/Preset.cpp:685-722@v02.09.01.70),
 * so no fix is ever offered, and no text suggests editing files.
 *
 * Where such a preset shows up:
 * - filaments go to the "Unsupported presets" group at the bottom, greyed out with a red flag
 *   (src/slic3r/GUI/PresetComboBoxes.cpp:1717-1729, 1851@v02.09.01.70);
 * - processes have no such group: an incompatible process is left out of the list unless it is
 *   the selected one (src/slic3r/GUI/PresetComboBoxes.cpp:2126-2135@v02.09.01.70).
 *
 * OrcaSlicer 2.4+ hides the "Unsupported presets" group unless Preferences > Developer > "Show
 * unsupported presets" is on. That setting only reaches the printer and filament lists
 * (PlaterPresetComboBox, src/slic3r/GUI/PresetComboBoxes.cpp:1505-1507@v2.5.0, and its help text,
 * src/slic3r/GUI/Preferences.cpp:2355@v2.5.0); the process list leaves an incompatible process
 * out either way (TabPresetComboBox, PresetComboBoxes.cpp:1763@v2.5.0).
 */
import type { SlicerProfile } from '../slicer.js';
import { TERMS } from '../terms.js';
import {
  RULE_IDS,
  type CompatContext,
  type CompatDetail,
  type Finding,
  type PresetType,
} from '../types.js';
import { joinList, shortList } from './r1Common.js';

export const R2_ID = RULE_IDS.printerNotAdded;
export const R3_ID = RULE_IDS.nozzleNotAdded;
export const R3_NOTE_ID = RULE_IDS.notForSelection;

/** Follows a printer name or model that Preset Doctor read from a printer's name. */
export const GUESSED_NOTE = "(Preset Doctor read this from the printer's name)";

/** How many printer names a text lists before "and N more". */
const NAMES_SHOWN = 3;

/** Where the slicer shows (or doesn't show) a preset that isn't for any added printer. */
function where(type: PresetType, profile: SlicerProfile, context: CompatContext): string {
  // The process list has no "Unsupported presets" group, and no setting adds one.
  if (type !== 'filament') {
    return `doesn't offer it in the ${TERMS[type].list} for any printer you've added`;
  }
  if (context.unsupportedGroup === 'hidden-by-setting') {
    return (
      `doesn't show it in the list at all for any printer you've added (${profile.displayName} ` +
      'hides unsupported presets unless Preferences > Developer > "Show unsupported presets" is on)'
    );
  }
  return 'lists it under "Unsupported presets" (greyed out) for every printer you\'ve added';
}

function sourceText(detail: CompatDetail, profile: SlicerProfile): string {
  switch (detail.source.kind) {
    case 'own':
      return 'Its printer list comes from its own settings.';
    case 'inherited':
      return `Its printer list is inherited from "${detail.source.from}".`;
    case 'name':
      return `Its printer list comes from its name (the part after "@"), as ${profile.shortName} reads it.`;
    case 'default':
      return '';
  }
}

/** "0.6 mm" / "0.6 or 0.8 mm" */
function sizes(nozzles: readonly string[], conjunction: 'or' | 'and'): string {
  return `${joinList(nozzles, conjunction)} mm`;
}

/** The R2/R3 finding for a preset, or null when its verdict needs none. */
export function compatFinding(
  args: {
    path: string;
    name: string;
    type: PresetType;
    detail: CompatDetail;
    context: CompatContext;
  },
  profile: SlicerProfile,
): Finding | null {
  const { detail, type } = args;
  const studio = profile.displayName;
  const short = profile.shortName;
  const intro = `${studio} loads this ${TERMS[type].noun}, but ${where(type, profile, args.context)}.`;
  const source = sourceText(detail, profile);
  const base = {
    presetPath: args.path,
    presetName: args.name,
    presetType: type,
    severity: 'info' as const,
    status: 'unsupported' as const,
    compat: detail,
  };
  const unknownNames = detail.unknownNames ?? [];
  const known = detail.printers.filter((p) => !unknownNames.includes(p));

  switch (detail.state) {
    case 'printer-not-added': {
      const also =
        unknownNames.length > 0
          ? ` It also lists printer names ${short} doesn't know (${shortList(quoted(unknownNames), NAMES_SHOWN)}).`
          : '';
      return {
        ...base,
        ruleId: R2_ID,
        title: "Only for printers you haven't added",
        explanation: join(
          intro,
          `It is made for ${shortList(known, NAMES_SHOWN)}, which you haven't added in ${short}.${also}`,
          source,
          `To use it, add ${known.length === 1 ? 'that printer' : 'one of those printers'} in ` +
            `${studio}'s printer selection. If you no longer have ${known.length === 1 ? 'it' : 'them'}, you ` +
            `can ignore this preset or delete it in ${short}.`,
        ),
      };
    }
    case 'unknown-printers':
      return {
        ...base,
        ruleId: R2_ID,
        title: `Only for printers ${short} doesn't know`,
        explanation: join(
          intro,
          `It lists printer names ${short} doesn't know (${shortList(quoted(detail.printers), NAMES_SHOWN)}), ` +
            'probably printers that were renamed or removed in an update.',
          source,
          `To keep using these settings, create a new preset for your printer in ${short} and ` +
            'copy the settings over.',
        ),
      };
    case 'printer-hidden': {
      const names = detail.hiddenPrinters ?? [];
      const one = names.length === 1;
      return {
        ...base,
        ruleId: R2_ID,
        title: "Made for a printer preset of yours that can't load",
        explanation: join(
          intro,
          `It is made for your printer preset${one ? '' : 's'} ` +
            `${shortList(quoted(names), NAMES_SHOWN)}, which ${short} can't load right now.`,
          source,
          `Repair ${one ? 'that printer preset' : 'those printer presets'} (Preset Doctor ` +
            `lists ${one ? 'it' : 'them'} with your printer presets), and this ` +
            `${TERMS[type].noun} shows again.`,
        ),
      };
    }
    case 'other-vendor': {
      const vendor = detail.vendor ?? 'another vendor';
      return {
        ...base,
        ruleId: R2_ID,
        title: "Made for another brand's printer profile",
        explanation: join(
          intro,
          `It is based on ${vendor}'s presets, and ${short} only offers those for ${vendor} ` +
            'printers. Your printers that fit its list use another profile (for example a ' +
            'printer you created yourself).',
          source,
        ),
      };
    }
    case 'nozzle-not-added': {
      const model = detail.model ?? 'printer';
      const guess = detail.guessed ? ` ${GUESSED_NOTE}` : '';
      return {
        ...base,
        ruleId: R3_ID,
        title: "Made for a nozzle size you haven't added",
        explanation: join(
          intro,
          `It is made for the ${model} with a ${sizes(detail.nozzles ?? [], 'or')} nozzle${guess}, ` +
            `and you've added the ${model} only with the ` +
            `${sizes(detail.addedNozzles ?? [], 'and')} nozzle.`,
          source,
          `To use it, add the ${sizes(detail.nozzles ?? [], 'or')} nozzle for that printer in ` +
            `${studio}'s printer selection.`,
        ),
      };
    }
    default:
      return null;
  }
}

/** One line for the table, per docs/design-v0.2.md section 5.4. */
export function compatReason(detail: CompatDetail, profile: SlicerProfile): string | undefined {
  switch (detail.state) {
    case 'printer-not-added': {
      const unknown = detail.unknownNames ?? [];
      const known = detail.printers.filter((p) => !unknown.includes(p));
      const more = known.length - 1;
      return `Only for printers you haven't added (${known[0] ?? ''}${more > 0 ? `, +${more}` : ''})`;
    }
    case 'nozzle-not-added':
      return `Made for the ${sizes(detail.nozzles ?? [], 'or')} nozzle, which you haven't added`;
    case 'unknown-printers':
      return `Lists printers ${profile.shortName} doesn't know`;
    case 'other-vendor':
      return "Made for another brand's printer profile";
    case 'printer-hidden':
      return `Made for your printer preset "${detail.hiddenPrinters?.[0] ?? ''}", which can't load`;
    default:
      return undefined;
  }
}

/** A preset counted in the grouped note. */
export interface OtherSelectionItem {
  name: string;
  type: PresetType;
  detail: CompatDetail;
}

/**
 * The one scan-level note for presets that are fine but made for another printer (or process)
 * that is added. Null when there are none. `otherNozzle`: some of them are for the selected
 * printer's model with another nozzle size, which Studio's multi-nozzle-size projects may offer
 * (src/libslic3r/Preset.cpp:3105-3110@v02.09.01.70; that mode lives in the project file).
 */
export function notForSelectionFinding(
  items: readonly OtherSelectionItem[],
  args: { otherNozzle: boolean },
  profile: SlicerProfile,
): Finding | null {
  if (items.length === 0) return null;
  const studio = profile.displayName;
  const short = profile.shortName;
  const printer = items.filter((i) => i.detail.state === 'other-printer');
  const sentences: string[] = [];
  if (printer.length > 0) {
    const filaments = printer.filter((i) => i.type === 'filament').length;
    const processes = printer.filter((i) => i.type === 'process').length;
    const counts = joinList(
      [
        ...(filaments > 0 ? [count(filaments, 'filament')] : []),
        ...(processes > 0 ? [count(processes, 'process')] : []),
      ],
      'and',
    );
    const one = printer.length === 1;
    sentences.push(
      `${counts} ${one ? 'is' : 'are'} made for another printer or nozzle you've added in ` +
        `${studio} (for example ${shortList(quoted(printer.map((i) => i.name)), NAMES_SHOWN)}). ` +
        `${short} shows ${one ? 'it' : 'them'} when you select that printer, so nothing is wrong ` +
        `with ${one ? 'it' : 'them'}.`,
    );
    if (args.otherNozzle) {
      sentences.push('If you use more than one nozzle size in one project, some may already show.');
    }
  }
  const mismatch = items.filter((i) => i.detail.process === 'mismatch');
  if (mismatch.length > 0) {
    const n = mismatch.length;
    const examples =
      printer.length > 0
        ? ''
        : ` (for example ${shortList(quoted(mismatch.map((i) => i.name)), NAMES_SHOWN)}); ` +
          `${short} shows ${n === 1 ? 'it' : 'them'} when you select one of those`;
    sentences.push(
      `${count(n, 'filament')} ${n === 1 ? 'is' : 'are'} only for other process presets than ` +
        `the selected one${examples}.`,
    );
  }
  return {
    ruleId: R3_NOTE_ID,
    severity: 'info',
    presetPath: profile.confFile,
    status: 'info',
    title:
      printer.length > 0
        ? "Some presets are for another printer you've added"
        : 'Some filament presets are for another process preset',
    explanation: sentences.join(' '),
  };
}

/** "3 filament presets" / "1 process preset" */
function count(n: number, type: 'filament' | 'process'): string {
  return `${n} ${type} preset${n === 1 ? '' : 's'}`;
}

function quoted(names: readonly string[]): string[] {
  return names.map((n) => `"${n}"`);
}

function join(...parts: string[]): string {
  return parts.filter((p) => p !== '').join(' ');
}
