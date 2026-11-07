/**
 * R1 for printer (machine) presets. Studio skips a user printer whose parent is gone, like any
 * other preset (src/libslic3r/Preset.cpp:1528-1531@v02.09.01.70), and then also loses it as the
 * selected printer: presets.machine falls back to the first visible one
 * (src/libslic3r/PresetBundle.cpp:2157-2216@v02.09.01.70). The nozzle and the printer change the
 * physics, so Preset Doctor never pre-selects a printer: the user always picks.
 *
 * Every selectable BBL printer is named "<printer_model> <printer_variant> nozzle" in every tag,
 * so the missing name is read with parseCompatiblePrinter and compared with each candidate's
 * effective printer_model and printer_variant (the 0.6 variant inherits the 0.4 one's model).
 * Candidates: instantiable system presets whose file says "type": "machine" (the g-code template
 * files in machine_list have no type), and the user's machine/base/ presets (wizard printers).
 */
import { getInfoValue, INFO_KEYS } from '../infoFile.js';
import { looseName, parseCompatiblePrinter, sameNozzle } from '../names.js';
import { presetName } from '../resolve.js';
import {
  RULE_IDS,
  type Candidate,
  type Confidence,
  type Finding,
  type UserPreset,
} from '../types.js';
import type { RuleContext } from './context.js';
import {
  eqi,
  missingIntro,
  nameFieldNote,
  orderCandidates,
  quoteCandidate,
  type RankedCandidate,
} from './r1Common.js';

interface Pooled {
  name: string;
  source: 'system' | 'user';
  settingId?: string;
  model?: string;
  nozzle?: string;
}

const NEVER_PICKS =
  'Preset Doctor never picks a printer for you: choose the one you actually have.';

export async function machineOrphanFinding(
  preset: UserPreset,
  name: string,
  missing: string,
  ctx: RuleContext,
): Promise<Finding> {
  const pool = await machinePool(preset, ctx);
  const baseId = preset.info ? getInfoValue(preset.info, INFO_KEYS.baseId)?.trim() : undefined;
  const ranked = rank(missing, baseId || undefined, pool);
  const high = ranked.filter((r) => r.candidate.confidence === 'high');
  const intro = missingIntro(missing, ctx.system);
  const body =
    high.length === 1
      ? ` The closest match is ${quoteCandidate(high[0]!.candidate)}.`
      : high.length > 1
        ? ` ${high.length} printer presets look like good replacements.`
        : ranked.length > 0
          ? ' There is no exact replacement. The closest options are listed below.'
          : ' Preset Doctor found no similar printer preset to switch to. You can add the printer ' +
            'again in Bambu Studio and copy your settings over.';
  const finding: Finding = {
    ruleId: RULE_IDS.orphanedParent,
    severity: 'error',
    presetPath: preset.path,
    presetName: name,
    status: 'hidden',
    title: 'Parent preset is missing',
    explanation:
      intro +
      body +
      (ranked.length > 0 ? ` ${NEVER_PICKS}` : '') +
      nameFieldNote(missing, ctx.presets),
  };
  if (ranked.length > 0) {
    finding.proposedFix = { kind: 'setInherits', candidates: ranked.map((r) => r.candidate) };
  }
  return finding;
}

async function machinePool(orphan: UserPreset, ctx: RuleContext): Promise<Pooled[]> {
  const pool: Pooled[] = [];
  const seen = new Set<string>();
  for (const body of await ctx.system.loadAll()) {
    if (!body.instantiation || body.fileType !== 'machine' || seen.has(body.studioName)) continue;
    seen.add(body.studioName);
    const p: Pooled = { name: body.studioName, source: 'system' };
    if (body.settingId !== undefined) p.settingId = body.settingId;
    const model = await ctx.system.effectiveValue(body.name, 'printerModel');
    const nozzle = await ctx.system.effectiveValue(body.name, 'printerVariant');
    if (model !== null) p.model = model;
    if (nozzle !== null) p.nozzle = nozzle;
    pool.push(p);
  }
  // Studio only finds a parent for a base/ preset among system presets.
  if (orphan.isBase) return pool;
  for (const u of ctx.presets) {
    if (u === orphan || !u.json || !u.isBase) continue;
    const name = presetName(u);
    if (name === undefined || name !== u.fileStem || seen.has(name)) continue;
    // A wizard printer has no parent; one with a parent would be no root.
    if (typeof u.json['inherits'] === 'string' && u.json['inherits'] !== '') continue;
    seen.add(name);
    const p: Pooled = { name, source: 'user' };
    const model = u.json['printer_model'];
    const nozzle = u.json['printer_variant'];
    if (typeof model === 'string' && model !== '') p.model = model;
    if (typeof nozzle === 'string' && nozzle !== '') p.nozzle = nozzle;
    pool.push(p);
  }
  return pool;
}

function rank(
  missing: string,
  baseId: string | undefined,
  pool: readonly Pooled[],
): RankedCandidate[] {
  const target = parseCompatiblePrinter(missing);
  const ranked: RankedCandidate[] = [];
  for (const c of pool) {
    const fromBaseId = baseId !== undefined && c.settingId === baseId;
    const push = (confidence: Confidence, reason: string, sortKey = 0): void => {
      const candidate: Candidate = {
        name: c.name,
        confidence,
        reason: c.source === 'user' ? `${reason} (one of your own presets)` : reason,
        // Never: the user picks the printer they have.
        preselected: false,
        source: c.source,
      };
      if (c.settingId !== undefined) candidate.settingId = c.settingId;
      ranked.push({ candidate, sortKey, fromBaseId });
    };

    if (looseName(c.name) === looseName(missing)) {
      push('high', 'Same name, only capitalization or spacing differs.');
      continue;
    }
    const sameModel = target !== null && c.model !== undefined && eqi(c.model, target.model);
    const sameSize =
      target !== null && c.nozzle !== undefined && sameNozzle(c.nozzle, target.nozzle);
    if (sameModel && sameSize) {
      const whose = c.source === 'user' ? 'Your own preset' : "Bambu's current preset";
      push('high', `${whose} for the ${c.model} with a ${c.nozzle} mm nozzle.`);
    } else if (fromBaseId) {
      push('medium', "Your preset's sync file (.info) says it was made from this printer.", -1);
    } else if (sameModel && c.nozzle !== undefined && target !== null) {
      push(
        'medium',
        `Same printer, but the ${c.nozzle} mm nozzle. The nozzle changes the print settings, so ` +
          "only pick this if that's the nozzle you have.",
        Math.abs(Number(c.nozzle) - Number(target.nozzle)),
      );
    } else if (
      sameSize &&
      target !== null &&
      c.model !== undefined &&
      sameBrand(c.model, target.model)
    ) {
      push('low', `A different printer: ${c.model}.`, -sharedWords(c.model, target.model));
    }
  }
  return orderCandidates(ranked);
}

/** Same first word ("Bambu Lab X1 Carbon" and "Bambu Lab N1"): the same printer maker. */
function sameBrand(a: string, b: string): boolean {
  return eqi(a.split(' ')[0], b.split(' ')[0]);
}

function sharedWords(a: string, b: string): number {
  const words = new Set(b.toLowerCase().split(' '));
  return a
    .toLowerCase()
    .split(' ')
    .filter((w) => words.has(w)).length;
}
