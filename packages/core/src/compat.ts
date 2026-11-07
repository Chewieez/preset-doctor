/**
 * R2/R3 inputs and verdicts: which printers a loaded filament or process preset is offered for,
 * compared with the printers that are added in the slicer. Pure apart from reading system
 * preset bodies through the index; never writes, never guesses what Studio would evaluate.
 *
 * What it mirrors (Bambu Studio v02.09.01.70, src/libslic3r/Preset.cpp):
 * - is_compatible_with_printer (:821-843): a preset with a vendor is incompatible with a printer
 *   of another vendor (:823-825), before anything else is looked at; a condition counts only
 *   when the list is empty (:829-837); else
 *   the list must be empty or name the printer (:838-840), or, for a user printer, its direct
 *   parent (:842, :811-819; "FIXME only check the parent");
 * - get_preset_with_vendor_profile (:2921-2933): the vendor is the nearest ancestor's;
 * - set_visible_from_appconfig (:873-884): a system printer is shown when the conf's "models"
 *   lists its printer_model and printer_variant; user printers (no vendor) always are (:877);
 * - is_compatible_with_print (:784-804): the same pattern for filaments against the process.
 * Not modelled: Studio's multi-nozzle-size mode (:3105-3110), which lives in the project file.
 */
import type { EnabledModel, SlicerConf } from './conf.js';
import { parseCompatiblePrinter } from './names.js';
import { chain, userInherits, type ResolveContext } from './resolve.js';
import type { SlicerProfile } from './slicer.js';
import type { SystemIndex } from './systemIndex.js';
import type { CompatContext, CompatDetail, CompatSource, PresetType, UserPreset } from './types.js';

/** A printer preset that a list entry can name. */
export interface PrinterRef {
  /** The name Studio knows it by: the file's "name" (system) or the file name (user). */
  name: string;
  /** Effective printer_model, e.g. 'Bambu Lab X2D'. */
  model?: string;
  /** Effective printer_variant: the nozzle size, e.g. '0.4'. */
  nozzle?: string;
  /** Vendor id of the nearest system ancestor (the preset itself if system); null for root user printers. */
  vendor: string | null;
  isUser: boolean;
  /** User printers: their direct inherits (Studio checks one level only). */
  inherits?: string;
  /** System printers: setting_id. */
  settingId?: string;
}

export interface CompatInputs {
  /** E: the added system printers plus every loaded user printer. */
  enabled: PrinterRef[];
  /** S: the conf's presets.machine, when it is a loaded printer. */
  selected?: PrinterRef;
  selectedProcess?: string;
  /** Every instantiable system printer by name, added or not, to map list entries to models. */
  knownPrinters: ReadonlyMap<string, PrinterRef>;
  enabledModels: readonly EnabledModel[];
  /** profile.vendorCheck: Studio checks the vendor, OrcaSlicer doesn't. */
  vendorCheck: boolean;
  /**
   * File names of the account's printer presets that the slicer can't load (R1/R4 hidden or
   * broken). A list naming one is for that printer, which a repair brings back.
   */
  hiddenUserPrinters?: ReadonlySet<string>;
}

/** A preset's compatibility values, as the slicer has them after loading. */
export interface EffectiveCompat {
  /** L: compatible_printers; null when no preset in the chain sets it. */
  printers: string[] | null;
  /** C: compatible_printers_condition; '' when unset. */
  printersCondition: string;
  /** compatible_prints (filament only); null when unset. */
  prints: string[] | null;
  printsCondition: string;
  /** Vendor id of the nearest system ancestor; null for a preset with none. */
  vendor: string | null;
  /** Where L came from. */
  source: CompatSource;
  /** The chain reached system presets whose values can't be read (OrcaSlicer .opc). */
  opaque?: boolean;
}

type JsonKey =
  | 'compatible_printers'
  | 'compatible_printers_condition'
  | 'compatible_prints'
  | 'compatible_prints_condition';
type IndexKey =
  | 'compatiblePrinters'
  | 'compatiblePrintersCondition'
  | 'compatiblePrints'
  | 'compatiblePrintsCondition';

const KEYS: readonly [JsonKey, IndexKey, 'list' | 'string'][] = [
  ['compatible_printers', 'compatiblePrinters', 'list'],
  ['compatible_printers_condition', 'compatiblePrintersCondition', 'string'],
  ['compatible_prints', 'compatiblePrints', 'list'],
  ['compatible_prints_condition', 'compatiblePrintsCondition', 'string'],
];

/** A user preset's own value for a key, if its file sets it (even to [] or ""). */
function ownValue(
  json: Record<string, unknown> | undefined,
  key: JsonKey,
  shape: 'list' | 'string',
): string[] | string | undefined {
  const v = json?.[key];
  if (shape === 'string') return typeof v === 'string' ? v : undefined;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

/**
 * The compatibility values of a user preset: its own value of each key when its file has the
 * key, otherwise the nearest ancestor's, walking user parents and then system parents. That is
 * how the loader builds a user preset: the parent's config, then the file's keys on top
 * (src/libslic3r/Preset.cpp:1521-1526@v02.09.01.70); Studio saves only the keys that differ
 * (:685-722). A custom filament with no parent and an empty list gets the part of its name after
 * "@" as its list, as Studio does at load (:1549-1559) and OrcaSlicer too
 * (src/libslic3r/Preset.cpp:1950-1959@v2.5.0); a user preset based on it that sets no list of
 * its own inherits that list. Returns null when the chain doesn't end at a root
 * (R1 reports those).
 */
export async function effectiveCompat(
  preset: UserPreset,
  system: SystemIndex,
  resolve: ResolveContext,
): Promise<EffectiveCompat | null> {
  const { links, end } = chain(preset, resolve);
  if (end.kind !== 'root') return null;
  const users = [preset, ...links.flatMap((l) => (l.kind === 'user' ? [l.preset] : []))];
  const sys = links.find((l) => l.kind === 'system');
  const values = new Map<JsonKey, { value: string[] | string; from: UserPreset | 'system' }>();
  for (const [jsonKey, indexKey, shape] of KEYS) {
    let found = false;
    for (const u of users) {
      const v = ownValue(u.json, jsonKey, shape);
      if (v !== undefined) {
        values.set(jsonKey, { value: v, from: u });
        found = true;
        break;
      }
    }
    if (found || !sys) continue;
    const v = await system.effectiveValue(sys.entry.name, indexKey);
    if (v !== null) values.set(jsonKey, { value: v, from: 'system' });
  }

  const list = (k: JsonKey): string[] | null => {
    const v = values.get(k)?.value;
    return Array.isArray(v) ? v : null;
  };
  const text = (k: JsonKey): string => {
    const v = values.get(k)?.value;
    return typeof v === 'string' ? v : '';
  };
  let printers = list('compatible_printers');
  const from = values.get('compatible_printers')?.from;
  let source: CompatSource =
    from === undefined
      ? { kind: 'default' }
      : from === preset
        ? { kind: 'own' }
        : {
            kind: 'inherited',
            from: from === 'system' ? (sys!.entry.currentName ?? sys!.name) : from.fileStem,
          };

  // The root of a chain without system presets: a custom filament. Studio loads it first (base/)
  // and rewrites its empty list at load, so its children inherit the rewritten list
  // (:1520-1524), unless one of them sets its own.
  const root = sys ? undefined : users[users.length - 1];
  if (
    preset.type === 'filament' &&
    root !== undefined &&
    userInherits(root) === '' &&
    (from === undefined || from === root) &&
    (printers === null || printers.length === 0)
  ) {
    const at = root.fileStem.indexOf('@');
    if (at >= 0 && at + 1 < root.fileStem.length) {
      printers = [root.fileStem.slice(at + 1)];
      source = root === preset ? { kind: 'name' } : { kind: 'inherited', from: root.fileStem };
    }
  }
  const eff: EffectiveCompat = {
    printers,
    printersCondition: text('compatible_printers_condition'),
    prints: list('compatible_prints'),
    printsCondition: text('compatible_prints_condition'),
    vendor: sys ? (system.get(sys.entry.name)?.vendor ?? null) : null,
    source,
  };
  // An OrcaSlicer parent whose settings can't be read (a .opc or bundle preset): its printer list
  // is unknown unless one of the user's own presets sets it.
  if (sys?.entry.opaque === true && values.get('compatible_printers')?.from === undefined) {
    eff.opaque = true;
  }
  return eff;
}

/**
 * Every instantiable system printer preset (a file with "type": "machine"; the g-code
 * templates in machine_list have none), with its effective model and nozzle size.
 */
export async function systemPrinters(machines: SystemIndex): Promise<PrinterRef[]> {
  const out: PrinterRef[] = [];
  const seen = new Set<string>();
  for (const body of await machines.loadAll()) {
    if (!body.instantiation || body.fileType !== 'machine' || seen.has(body.studioName)) continue;
    seen.add(body.studioName);
    const ref: PrinterRef = { name: body.studioName, vendor: body.vendor, isUser: false };
    if (body.settingId !== undefined) ref.settingId = body.settingId;
    const model = await machines.effectiveValue(body.name, 'printerModel');
    if (model !== null) ref.model = model;
    const nozzle = await machines.effectiveValue(body.name, 'printerVariant');
    if (nozzle !== null) ref.nozzle = nozzle;
    out.push(ref);
  }
  return out;
}

/**
 * A loaded user printer: known by its file name, matched also by its direct parent. Its vendor,
 * model and nozzle come from the nearest preset in its chain that has them.
 */
export async function userPrinter(
  preset: UserPreset,
  machines: SystemIndex | null,
  resolve: ResolveContext,
): Promise<PrinterRef> {
  const { links } = chain(preset, resolve);
  const users = [preset, ...links.flatMap((l) => (l.kind === 'user' ? [l.preset] : []))];
  const sys = links.find((l) => l.kind === 'system');
  const pick = async (
    jsonKey: 'printer_model' | 'printer_variant',
    indexKey: 'printerModel' | 'printerVariant',
  ): Promise<string | undefined> => {
    for (const u of users) {
      const v = u.json?.[jsonKey];
      if (typeof v === 'string') return v;
    }
    if (!sys || !machines) return undefined;
    return (await machines.effectiveValue(sys.entry.name, indexKey)) ?? undefined;
  };
  const ref: PrinterRef = {
    name: preset.fileStem,
    vendor: sys && machines ? (machines.get(sys.entry.name)?.vendor ?? null) : null,
    isUser: true,
  };
  const inherits = userInherits(preset);
  if (inherits !== '') ref.inherits = inherits;
  const model = await pick('printer_model', 'printerModel');
  if (model !== undefined) ref.model = model;
  const nozzle = await pick('printer_variant', 'printerVariant');
  if (nozzle !== undefined) ref.nozzle = nozzle;
  return ref;
}

/** True when the conf's "models" adds this system printer (AppConfig::get_variant). */
export function isEnabled(p: PrinterRef, models: readonly EnabledModel[]): boolean {
  return models.some(
    (m) =>
      m.vendor === p.vendor &&
      m.model === p.model &&
      p.nozzle !== undefined &&
      m.nozzles.includes(p.nozzle),
  );
}

/** Does the list name this printer (or, for a user printer, its direct parent)? */
function matches(list: readonly string[], x: PrinterRef): boolean {
  return (
    list.includes(x.name) || (x.isUser && x.inherits !== undefined && list.includes(x.inherits))
  );
}

/**
 * The verdict for one preset, in the order of docs/design-v0.2.md section 5.3. Processes are
 * never checked against a filament (src/libslic3r/PresetBundle.cpp:7382-7383@v02.09.01.70).
 */
export function judgeCompat(
  eff: EffectiveCompat,
  type: PresetType,
  inputs: CompatInputs,
): CompatDetail {
  const list = eff.printers ?? [];
  const base = { printers: [...list], source: eff.source };
  if (eff.opaque) return { ...base, state: 'cant-tell', why: 'opaque' };

  // The vendor test comes first in Studio, before the list or the condition (:823-825).
  const sameVendor = (x: PrinterRef): boolean =>
    !inputs.vendorCheck || eff.vendor === null || x.vendor === eff.vendor;
  const fitting = inputs.enabled.filter(sameVendor);
  const S = inputs.selected;
  if (list.length === 0) {
    if (fitting.length === 0 && inputs.enabled.length > 0) {
      const out: CompatDetail = {
        ...base,
        state: 'other-vendor',
        matchedPrinters: inputs.enabled.map((x) => x.name),
      };
      if (eff.vendor !== null) out.vendor = eff.vendor;
      return out;
    }
    if (eff.printersCondition.trim() !== '')
      return { ...base, state: 'cant-tell', why: 'condition' };
    if (S && !sameVendor(S) && fitting.length > 0) {
      return { ...base, state: 'other-printer', matchedPrinters: fitting.map((x) => x.name) };
    }
    return withProcess({ ...base, state: 'all' }, eff, type, inputs);
  }

  if (S && sameVendor(S) && matches(list, S)) {
    return withProcess({ ...base, state: 'selected' }, eff, type, inputs);
  }
  const matched = fitting.filter((x) => matches(list, x)).map((x) => x.name);
  if (matched.length > 0) return { ...base, state: 'other-printer', matchedPrinters: matched };
  // Added printers that fit the list but use another vendor profile. (Without such a printer,
  // the list is for printers that aren't added: R2 says which, which is more use than the vendor.)
  const otherVendor = inputs.enabled.filter((x) => !sameVendor(x) && matches(list, x));
  if (otherVendor.length > 0) {
    const out: CompatDetail = {
      ...base,
      state: 'other-vendor',
      matchedPrinters: otherVendor.map((x) => x.name),
    };
    if (eff.vendor !== null) out.vendor = eff.vendor;
    return out;
  }

  // Made for one of the account's own printers that can't load now: repairing it is the fix.
  const hidden = list.filter((n) => inputs.hiddenUserPrinters?.has(n) === true);
  if (hidden.length > 0) return { ...base, state: 'printer-hidden', hiddenPrinters: hidden };

  // Map each entry to a model and nozzle: from the profile, or else from the name.
  const mapped = list.map((name): MappedEntry => {
    const known = inputs.knownPrinters.get(name);
    if (known) return { name, model: known.model, nozzle: known.nozzle, vendor: known.vendor };
    const parsed = parseCompatiblePrinter(name);
    return parsed
      ? { name, model: parsed.model, nozzle: parsed.nozzle, unknown: true, guessed: true }
      : { name, unknown: true };
  });
  const enabledModel = (e: MappedEntry): EnabledModel | undefined =>
    e.model === undefined
      ? undefined
      : inputs.enabledModels.find(
          (m) => m.model === e.model && (e.vendor === undefined || m.vendor === e.vendor),
        );
  const nozzleOnly = mapped.find((e) => {
    const m = enabledModel(e);
    return m !== undefined && e.nozzle !== undefined && !m.nozzles.includes(e.nozzle);
  });
  if (nozzleOnly) {
    const m = enabledModel(nozzleOnly)!;
    const forModel = mapped.filter(
      (e) =>
        e.model === nozzleOnly.model && e.nozzle !== undefined && !m.nozzles.includes(e.nozzle),
    );
    const out: CompatDetail = {
      ...base,
      state: 'nozzle-not-added',
      model: m.model,
      nozzles: [...new Set(forModel.map((e) => e.nozzle!))],
      addedNozzles: [...m.nozzles],
    };
    if (forModel.some((e) => e.guessed)) out.guessed = true;
    return out;
  }
  const unknown = mapped.filter((e) => e.unknown).map((e) => e.name);
  const guessed = mapped.some((e) => e.guessed);
  const out: CompatDetail =
    unknown.length < mapped.length
      ? { ...base, state: 'printer-not-added' }
      : { ...base, state: 'unknown-printers' };
  if (unknown.length > 0) out.unknownNames = unknown;
  if (guessed) out.guessed = true;
  return out;
}

/** A list entry mapped to a printer model and nozzle size. */
interface MappedEntry {
  name: string;
  model?: string | undefined;
  nozzle?: string | undefined;
  /** undefined: not known (read from the name), so any vendor's model of that name counts. */
  vendor?: string | null;
  /** No printer profile has this name. */
  unknown?: boolean;
  /** The model and nozzle were read from the name. */
  guessed?: boolean;
}

/** Step 8: a filament against the selected process (src/libslic3r/Preset.cpp:784-804@v02.09.01.70). */
function withProcess(
  detail: CompatDetail,
  eff: EffectiveCompat,
  type: PresetType,
  inputs: CompatInputs,
): CompatDetail {
  if (type !== 'filament' || inputs.selectedProcess === undefined) return detail;
  const prints = eff.prints ?? [];
  if (prints.length > 0) {
    if (!prints.includes(inputs.selectedProcess)) detail.process = 'mismatch';
  } else if (eff.printsCondition.trim() !== '') {
    detail.process = 'cant-tell';
  }
  return detail;
}

/** The verdicts that get a finding of their own (the others only annotate the row). */
export function isUnsupported(detail: CompatDetail): boolean {
  return (
    detail.state === 'nozzle-not-added' ||
    detail.state === 'printer-not-added' ||
    detail.state === 'unknown-printers' ||
    detail.state === 'other-vendor' ||
    detail.state === 'printer-hidden'
  );
}

/** Counted in the grouped "for another printer you've added" note. */
export function isForOtherSelection(detail: CompatDetail): boolean {
  return detail.state === 'other-printer' || detail.process === 'mismatch';
}

export interface CompatSetup {
  /** null when R2/R3 can't run; `context.why` says why. */
  inputs: CompatInputs | null;
  context: CompatContext;
}

/**
 * Builds the inputs once per scan: the added printers (E) and the selected one (S) from the
 * conf, the system printer index and the account's loaded printer presets.
 *
 * `userMachines` are the printer presets Studio loads (not hidden or broken). `presets.*` is one
 * global selection, not per account. When the conf has no "models" section but names a
 * selected printer, that printer counts as added.
 */
export async function compatSetup(args: {
  conf: SlicerConf;
  profile: SlicerProfile;
  machines: SystemIndex | null;
  userMachines: readonly UserPreset[];
  /** The account's printer presets the slicer can't load (hidden or broken). */
  hiddenUserMachines?: readonly UserPreset[];
  resolve: ResolveContext | undefined;
}): Promise<CompatSetup> {
  const { conf, profile, machines } = args;
  const unsupportedGroup = profile.unsupportedGroup(conf);
  const skipped = (why: NonNullable<CompatContext['why']>): CompatSetup => ({
    inputs: null,
    context: { checked: false, why, enabled: [], userPrinters: 0, unsupportedGroup },
  });
  if (!conf.found) return skipped('no-conf');
  if (conf.enabledModels === undefined && conf.selectedPrinter === undefined) {
    return skipped(conf.error !== undefined ? 'conf-unreadable' : 'no-printers');
  }
  if (!machines) return skipped('system-unreadable');

  const known = await systemPrinters(machines);
  const knownPrinters = new Map(known.map((p) => [p.name, p]));
  const enabledModels = conf.enabledModels ?? [];
  const resolve = args.resolve ?? { system: machines, userByName: new Map() };
  const users: PrinterRef[] = [];
  for (const p of args.userMachines) users.push(await userPrinter(p, machines, resolve));
  const enabled = [...known.filter((p) => isEnabled(p, enabledModels)), ...users];

  let selected: PrinterRef | undefined;
  if (conf.selectedPrinter !== undefined) {
    selected =
      knownPrinters.get(conf.selectedPrinter) ?? users.find((u) => u.name === conf.selectedPrinter);
    // Studio shows only added printers, but the one it has selected is in the list either way.
    if (selected && !enabled.includes(selected)) enabled.push(selected);
  }

  const inputs: CompatInputs = {
    enabled,
    knownPrinters,
    enabledModels,
    vendorCheck: profile.vendorCheck,
  };
  if (selected) inputs.selected = selected;
  if (conf.selectedProcess !== undefined) inputs.selectedProcess = conf.selectedProcess;
  const hidden = (args.hiddenUserMachines ?? []).map((p) => p.fileStem);
  if (hidden.length > 0) inputs.hiddenUserPrinters = new Set(hidden);
  const context: CompatContext = {
    checked: true,
    enabled: enabledModels.map((m) => ({ ...m, nozzles: [...m.nozzles] })),
    userPrinters: users.length,
    unsupportedGroup,
  };
  if (selected) context.selectedPrinter = selected.name;
  if (conf.selectedProcess !== undefined) context.selectedProcess = conf.selectedProcess;
  return { inputs, context };
}
