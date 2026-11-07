/**
 * One scan of a Bambu Studio or OrcaSlicer folder for one account: reads the system indexes, the
 * account's presets of every type and the slicer's conf (BambuStudio.conf / OrcaSlicer.conf),
 * runs every rule and summarizes each preset as a table row. Only reads; never writes.
 */
import {
  compatSetup,
  customFilamentAlias,
  effectiveCompat,
  judgeCompat,
  markFamilyCopies,
  type AliasHolder,
  type CompatInputs,
} from './compat.js';
import { readSlicerConf, type SlicerConf } from './conf.js';
import type { PresetFs } from './fs.js';
import { buildUserIndex, chain, userInherits, type ResolveContext } from './resolve.js';
import type { RuleContext } from './rules/context.js';
import { orcaParentLookup } from './orcaLookup.js';
import { checkR1, displayName, R1_ID, userCandidateNames } from './rules/r1.js';
import { rewordFinding, TEMPLATE_PARENT_TITLE } from './rules/r1Common.js';
import {
  compatFinding,
  compatReason,
  familyCopiesFinding,
  notForSelectionFinding,
  type OtherSelectionItem,
} from './rules/r2r3.js';
import { checkR4, type R4Context } from './rules/r4.js';
import { detectSlicer, type SlicerProfile } from './slicer.js';
import { loadSystemIndexSet, studioNameLookup, type SystemIndexSet } from './systemIndex.js';
import { TERMS } from './terms.js';
import {
  PRESET_TYPES,
  RULE_IDS,
  type CompatContext,
  type CompatDetail,
  type Finding,
  type PresetStatus,
  type PresetSummary,
  type PresetType,
  type ScanResult,
  type Severity,
  type UserPreset,
} from './types.js';
import { countTypes, listAccounts, scanUser } from './userScan.js';

export const R5_ID = RULE_IDS.cloudSync;
export { CLOUD_SYNC_EXPLANATION } from './slicer.js';

/** Added to a process or machine index's load error (the filament one has its own, below). */
const INDEX_UNREADABLE: Record<PresetType, string> = {
  filament: "Missing parent presets can't be checked without it.",
  process: "Process presets based on system presets can't be checked.",
  machine: "Printer presets based on system presets can't be checked.",
};

export interface ScanOptions {
  /** Account folder to scan. Default: the one with the most presets. */
  userId?: string;
  /** Shown as ScanResult.root. Default: the adapter's `root` property when it has one. */
  root?: string;
}

/** The folder can't be scanned at all (not a Studio folder, unknown account). */
export class ScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanError';
  }
}

const STATUS_RANK: Record<PresetStatus, number> = {
  ok: 0,
  info: 1,
  unsupported: 2,
  hidden: 3,
  broken: 4,
};
const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

export async function scan(fs: PresetFs, options: ScanOptions = {}): Promise<ScanResult> {
  const root = options.root ?? rootOf(fs);
  const warnings: string[] = [];
  const detected = await detectSlicer(fs);
  if (!detected.ok) {
    throw new ScanError(
      detected.reason === 'neither'
        ? `${root || 'This folder'} ${detected.message}`
        : detected.message,
    );
  }
  const profile = detected.profile;
  const accounts = await listAccounts(fs);

  const indexes = await loadSystemIndexSet(fs, profile);
  const system = indexes.byType.filament;
  const filamentError = indexes.errors.filament;
  if (filamentError) warnings.push(`${filamentError.message} ${INDEX_UNREADABLE.filament}`);
  if (!system && accounts.length === 0) {
    throw new ScanError(
      profile.id === 'bambu'
        ? `${root || 'This folder'} doesn't look like a Bambu Studio data folder: no system ` +
            'preset index (system/BBL.json) was found, and there is no user folder.'
        : `${root || 'This folder'} doesn't look like a complete ${profile.displayName} data ` +
            'folder: no system preset index (system/<vendor>.json) could be read, and there is ' +
            'no user folder.',
    );
  }
  if (indexes.opaque.length > 0) {
    // OrcaSlicer 2.5 (opc.ts): parents are checked by name only, and nothing is suggested.
    warnings.push(
      `OrcaSlicer's built-in presets for ${indexes.opaque.map((o) => o.vendor).join(', ')} are ` +
        'in its packed format; Preset Doctor checks only that parents exist and suggests no ' +
        'replacements for them.',
    );
  }

  const userId = options.userId ?? accounts[0]?.id ?? '';
  if (options.userId !== undefined && !accounts.some((a) => a.id === options.userId)) {
    const known = accounts.map((a) => a.id).join(', ') || 'none';
    throw new ScanError(`There is no account folder "${options.userId}". Found: ${known}.`);
  }
  if (userId === '') warnings.push('No user presets were found in this folder.');

  const presets = userId === '' ? [] : await scanUser(fs, userId);
  const findings: Finding[] = [];

  const conf = await readSlicerConf(fs, profile);
  if (conf.syncUserPreset === true) findings.push(cloudSyncFinding(profile, conf));
  else if (conf.error !== undefined && conf.syncUserPreset === undefined) {
    // Sync may well be on: say so, rather than staying as quiet as when it is off.
    warnings.push(
      `${conf.error} Preset Doctor could not tell whether cloud preset sync is on. If it is, a ` +
        'repair stays on this computer until you save the preset in Bambu Studio.',
    );
  }
  // When the filament index failed, its warning already says the system presets can't be read.
  if (system) {
    for (const type of PRESET_TYPES) {
      const err = type === 'filament' ? undefined : indexes.errors[type];
      if (err) warnings.push(`${err.message} ${INDEX_UNREADABLE[type]}`);
    }
  }

  // Each type is its own collection in Studio: parents only resolve within the same type, and
  // a rename only clashes with names of the same type.
  const r1s = new Map<UserPreset, Finding>();
  const r4ctx = new Map<PresetType, R4Context>();
  const resolves = new Map<PresetType, ResolveContext>();
  for (const type of PRESET_TYPES) {
    const list = presets.filter((p) => p.type === type);
    const index = indexes.byType[type];
    const typeR1: Finding[] = [];
    // R1 runs first, so R4 won't rename a preset that R1 suggests as someone's new parent.
    if (index && list.length > 0) {
      // Parents are resolved by the names the slicer itself uses (see studioNameLookup), and
      // OrcaSlicer also finds renamed and "Generic" parents (orcaLookup.ts).
      const orca =
        profile.parentLookup === 'orca'
          ? await orcaParentLookup({
              system: index,
              set: indexes,
              fs,
              accountId: userId,
              type,
              presets: list,
              version: profile.versionFrom(conf),
            })
          : undefined;
      const ctx: RuleContext = {
        type,
        profile,
        system: index,
        presets: list,
        resolve: {
          system: orca ?? (await studioNameLookup(index, list)),
          userByName: buildUserIndex(list),
        },
      };
      if (orca) ctx.orca = orca;
      resolves.set(type, ctx.resolve);
      for (const preset of list) {
        const r1 = await checkR1(preset, ctx);
        if (r1) {
          r1s.set(preset, r1);
          typeR1.push(r1);
        }
      }
    }
    r4ctx.set(type, {
      presets: list,
      suggestedParents: userCandidateNames(typeR1),
      ...(index ? { system: index } : {}),
    });
  }

  const ownFindings = new Map<UserPreset, Finding[]>();
  for (const preset of presets) {
    const own: Finding[] = [];
    const r1 = r1s.get(preset);
    if (r1) own.push(r1);
    own.push(...checkR4(preset, r4ctx.get(preset.type)!).map((f) => rewordFinding(f, profile)));
    for (const f of own) f.presetType = preset.type;
    ownFindings.set(preset, own);
  }

  // R2/R3 judge only the presets Studio loads, so they run after R1 and R4.
  const compat = await compatPass({ profile, conf, indexes, presets, ownFindings, resolves });
  const summaries: PresetSummary[] = [];
  for (const preset of presets) {
    const own = ownFindings.get(preset)!;
    const detail = compat.details.get(preset);
    if (detail) {
      const f = compatFinding(
        {
          path: preset.path,
          name: displayName(preset),
          type: preset.type,
          detail,
          context: compat.context,
        },
        profile,
      );
      // A copy's note goes first, so it is the row's reason over an R4 note of the same rank.
      if (f?.status === 'info') own.unshift(f);
      else if (f) own.push(f);
    }
    findings.push(...own);
    const summary = summarize(preset, own, indexes.byType[preset.type] !== null, profile);
    if (detail) summary.compat = detail;
    summaries.push(summary);
  }
  findings.push(...compat.notes);

  // The filament index's warnings as before, then the others' new ones.
  const filamentWarnings = system?.warnings ?? [];
  const otherWarnings = PRESET_TYPES.flatMap((t) =>
    t === 'filament' ? [] : (indexes.byType[t]?.warnings ?? []),
  ).filter((w) => !filamentWarnings.includes(w));
  warnings.push(...filamentWarnings, ...new Set(otherWarnings));
  const shownWarnings = warnings.map((w) => profile.reword(w));
  const indexesRead: Record<PresetType, boolean> = {
    filament: indexes.byType.filament !== null,
    process: indexes.byType.process !== null,
    machine: indexes.byType.machine !== null,
  };
  return {
    root,
    userId,
    accounts,
    presets: summaries,
    findings,
    warnings: shownWarnings,
    systemVersion: indexes.version,
    systemIndexRead: PRESET_TYPES.every((t) => indexesRead[t]),
    slicer: profile.id,
    slicerVersion: profile.versionFrom(conf),
    countsByType: countTypes(presets),
    indexesRead,
    compat: compat.context,
  };
}

/**
 * R2/R3: the compatibility verdict of every loaded filament and process preset, plus the
 * grouped note. Skipped: presets that R1 or R4 report as hidden or broken, presets whose chain
 * passes through one, and files with "instantiation": "false", which Studio loads but never
 * shows (src/libslic3r/Preset.cpp:1505-1506@v02.09.01.70). Printer presets are never judged:
 * Studio has no compatibility check for them (src/libslic3r/Preset.cpp:873-884@v02.09.01.70).
 */
async function compatPass(args: {
  profile: SlicerProfile;
  conf: SlicerConf;
  indexes: SystemIndexSet;
  presets: readonly UserPreset[];
  ownFindings: ReadonlyMap<UserPreset, Finding[]>;
  resolves: ReadonlyMap<PresetType, ResolveContext>;
}): Promise<{
  context: CompatContext;
  details: Map<UserPreset, CompatDetail>;
  /** The grouped notes: presets for another added printer, and copies of a custom filament. */
  notes: Finding[];
}> {
  const { profile, indexes, presets, ownFindings, resolves } = args;
  const blocked = new Set(
    presets.filter((p) =>
      (ownFindings.get(p) ?? []).some((f) => f.status === 'hidden' || f.status === 'broken'),
    ),
  );
  const shown = (p: UserPreset): boolean =>
    p.json !== undefined && !blocked.has(p) && !notInstantiated(p);
  const setup = await compatSetup({
    conf: args.conf,
    profile,
    machines: indexes.byType.machine,
    userMachines: presets.filter((p) => p.type === 'machine' && shown(p)),
    hiddenUserMachines: presets.filter((p) => p.type === 'machine' && blocked.has(p)),
    resolve: resolves.get('machine'),
  });
  const details = new Map<UserPreset, CompatDetail>();
  const inputs = setup.inputs;
  if (!inputs) return { context: setup.context, details, notes: [] };

  const items: OtherSelectionItem[] = [];
  // Custom filaments Studio loads but never shows still hold printers for their alias.
  const holders: AliasHolder[] = [];
  for (const preset of presets) {
    if (preset.type === 'machine') continue;
    const system = indexes.byType[preset.type];
    const resolve = resolves.get(preset.type);
    if (!system || !resolve) continue;
    if (!shown(preset)) {
      if (preset.json !== undefined && !blocked.has(preset) && customFilamentAlias(preset)) {
        const eff = await effectiveCompat(preset, system, resolve);
        if (eff) holders.push({ preset, printers: eff.printers ?? [] });
      }
      continue;
    }
    const { links } = chain(preset, resolve);
    if (links.some((l) => l.kind === 'user' && !shown(l.preset))) continue;
    const eff = await effectiveCompat(preset, system, resolve);
    if (!eff) continue;
    const detail = judgeCompat(eff, preset.type, inputs);
    details.set(preset, detail);
    // Without a known selected printer, "made for another printer" says nothing.
    if (
      (detail.state === 'other-printer' && inputs.selected !== undefined) ||
      detail.process === 'mismatch'
    ) {
      items.push({ name: displayName(preset), type: preset.type, detail });
    }
  }
  const note = notForSelectionFinding(items, { otherNozzle: otherNozzle(items, inputs) }, profile);
  // Copies of a custom filament whose family has a copy for an added printer: one name in the
  // slicer, so they go in their own grouped note instead of being reported as unsupported.
  markFamilyCopies(details, holders, displayName);
  const copies = presets.flatMap((p) => {
    const family = details.get(p)?.family;
    return family ? [{ name: displayName(p), family }] : [];
  });
  const copiesNote = familyCopiesFinding(copies, setup.context, profile);
  return {
    context: setup.context,
    details,
    notes: [...(note ? [note] : []), ...(copiesNote ? [copiesNote] : [])],
  };
}

/** A file with "instantiation": "false": Studio loads it, but never shows it. */
function notInstantiated(p: UserPreset): boolean {
  const v = p.json?.['instantiation'];
  return v === 'false' || v === false;
}

/** Is one of these presets for the selected printer's model, but with another nozzle size? */
function otherNozzle(items: readonly OtherSelectionItem[], inputs: CompatInputs): boolean {
  const s = inputs.selected;
  if (s?.model === undefined) return false;
  return items.some((i) =>
    (i.detail.matchedPrinters ?? []).some((name) => {
      const x = inputs.enabled.find((p) => p.name === name);
      return x !== undefined && x.model === s.model && x.nozzle !== s.nozzle;
    }),
  );
}

function cloudSyncFinding(profile: SlicerProfile, conf: SlicerConf): Finding {
  const text = profile.cloudSyncText(conf);
  return {
    ruleId: R5_ID,
    // A note, not a warning: nothing is wrong, and the text says turning sync off isn't needed.
    severity: 'info',
    presetPath: profile.confFile,
    status: 'info',
    title: text.title,
    // Bambu Studio's source, v02.09.01.70 (SPEC section 10, question 3): a cloud copy whose
    // parent is missing is skipped like the local one (src/libslic3r/Preset.cpp:2112-2124), and
    // a preset with no sidecar, or a sidecar that has a setting_id and an empty sync_info, is
    // not uploaded (get_user_presets, Preset.cpp:1922-1926); saving the preset in Studio flags it
    // (src/slic3r/GUI/Tab.cpp:7733-7743). A sidecar with base_id but no setting_id yet, or a
    // pending sync_info, is uploaded on its own (src/slic3r/GUI/GUI_App.cpp:6849-6877).
    explanation: text.explanation,
  };
}

/** `parentsChecked` is false when the preset type's system index could not be read, so R1 did not run. */
function summarize(
  preset: UserPreset,
  findings: Finding[],
  parentsChecked: boolean,
  profile: SlicerProfile,
): PresetSummary {
  const worst = [...findings].sort(
    (a, b) =>
      STATUS_RANK[b.status] - STATUS_RANK[a.status] ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  )[0];
  const inherits = preset.json ? userInherits(preset) : undefined;
  // Without the system index a parent was never checked, so don't call the preset OK; that
  // matters more than any note, but less than a real problem.
  const unchecked =
    !parentsChecked &&
    inherits !== undefined &&
    inherits !== '' &&
    (worst === undefined || STATUS_RANK[worst.status] <= STATUS_RANK.info);
  const summary: PresetSummary = {
    type: preset.type,
    accountId: preset.accountId,
    path: preset.path,
    fileStem: preset.fileStem,
    isBase: preset.isBase,
    status: unchecked ? 'info' : (worst?.status ?? 'ok'),
    reason: unchecked
      ? `Parent "${inherits}" could not be checked (system presets unreadable)`
      : worst
        ? reasonFor(worst, inherits, profile)
        : okReason(inherits, preset.type),
    ruleIds: [...new Set(findings.map((f) => f.ruleId))],
  };
  if (preset.json) summary.name = displayName(preset);
  if (inherits !== undefined) summary.inherits = inherits;
  return summary;
}

function reasonFor(f: Finding, inherits: string | undefined, profile: SlicerProfile): string {
  if (f.compat) return compatReason(f.compat, profile) ?? f.title;
  // Direct orphans name the missing parent; hidden children of orphans keep the title.
  if (f.ruleId === R1_ID && f.severity === 'error' && f.status === 'hidden' && inherits) {
    return f.title === TEMPLATE_PARENT_TITLE
      ? `Based on the template "${inherits}", not a preset`
      : `Parent "${inherits}" is missing`;
  }
  return f.title;
}

function okReason(inherits: string | undefined, type: PresetType): string {
  return inherits ? `Based on "${inherits}"` : TERMS[type].rootReason;
}

function rootOf(fs: PresetFs): string {
  const r = (fs as { root?: unknown }).root;
  return typeof r === 'string' ? r : '';
}
