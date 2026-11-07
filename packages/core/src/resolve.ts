/**
 * Walks `inherits` links between presets.
 *
 * In Bambu Studio a user preset may inherit from a system preset or from another user preset
 * of the same account (including wizard presets in filament/base/). System presets only ever
 * inherit from other system presets.
 *
 * Studio knows a user preset only by its file name without ".json", never by the "name" inside
 * the file (PresetCollection::load_presets, src/libslic3r/Preset.cpp:1455, 1464, 1516@v02.09.01.70),
 * so user parents are looked up by file name. Not modelled yet: Studio loads filament/base/ first
 * and adds each pass only after it ends (Preset.cpp:1425-1427, 1598), so a base/ preset can only
 * have a system parent and a top-level preset can't have a top-level parent (SPEC section 10).
 */
import type { UserPreset } from './types.js';

/**
 * The little this module needs from a system preset. Kept minimal so any system index whose
 * entries carry these fields fits structurally.
 */
export interface SystemPresetLike {
  name: string;
  /** Parent name; '' or undefined at the top of the chain. */
  inherits?: string | undefined;
  /** It exists, but its settings can't be read (an OrcaSlicer .opc or bundle preset). */
  opaque?: true | undefined;
  /** OrcaSlicer found it under another name (renamed_from, "Generic" fallback): that name. */
  currentName?: string | undefined;
}

export interface SystemLookup {
  get(name: string): SystemPresetLike | undefined;
}

export interface ResolveContext {
  system: SystemLookup;
  /** User presets of the scanned account, keyed by file name (see buildUserIndex). */
  userByName: ReadonlyMap<string, UserPreset>;
}

export type ResolvedPreset =
  | { kind: 'system'; name: string; entry: SystemPresetLike }
  | { kind: 'user'; name: string; preset: UserPreset };

/** Safety net for absurdly long chains; real chains are under 10 links. */
const MAX_CHAIN_DEPTH = 64;

/**
 * Indexes user presets by file name (without .json), the only name Studio knows them by (see
 * the module comment). A child that inherits a preset's `name` field when that differs from its
 * file name is therefore orphaned, as in Studio; R1 and R4 explain the mismatch. The first preset
 * wins on duplicates; top-level presets come before base/ ones from scanUser.
 */
export function buildUserIndex(presets: readonly UserPreset[]): Map<string, UserPreset> {
  const byName = new Map<string, UserPreset>();
  for (const p of presets) if (!byName.has(p.fileStem)) byName.set(p.fileStem, p);
  return byName;
}

/** The preset's `name` field, if it is a non-empty string. */
export function presetName(p: UserPreset): string | undefined {
  const n = p.json?.['name'];
  return typeof n === 'string' && n !== '' ? n : undefined;
}

/** The preset's `inherits` field; '' when absent or not a string (= no parent). */
export function userInherits(p: UserPreset): string {
  const v = p.json?.['inherits'];
  return typeof v === 'string' ? v : '';
}

/**
 * Finds the preset a name refers to. System presets are checked first, as Studio does (user
 * preset names cannot shadow system ones). Returns null for an empty name or a missing preset;
 * callers treat '' as "no parent", not as an orphan.
 */
export function resolveParent(name: string, ctx: ResolveContext): ResolvedPreset | null {
  if (name === '') return null;
  const entry = ctx.system.get(name);
  if (entry) return { kind: 'system', name, entry };
  const preset = ctx.userByName.get(name);
  if (preset) return { kind: 'user', name, preset };
  return null;
}

export type ChainEnd =
  /** Reached a preset with no parent. */
  | { kind: 'root' }
  /** A link points at a preset that does not exist: the orphan case (R1). */
  | { kind: 'missing'; name: string; referencedBy: string }
  /** A preset that is already in the chain shows up again. */
  | { kind: 'cycle'; name: string }
  | { kind: 'tooDeep' };

export interface Chain {
  /** Ancestors, nearest first. Does not include the starting preset. */
  links: ResolvedPreset[];
  end: ChainEnd;
}

/** Walks from a user preset up to its root ancestor. */
export function chain(preset: UserPreset, ctx: ResolveContext): Chain {
  const startName = presetName(preset) ?? preset.fileStem;
  const links: ResolvedPreset[] = [];
  // Studio's own name for the preset is its file name (see buildUserIndex).
  const seen = new Set<string>([preset.fileStem]);
  let parent = userInherits(preset);
  let child = startName;
  // Once the walk reaches a system preset it stays there: system presets never inherit user ones.
  let inSystem = false;

  while (parent !== '') {
    if (seen.has(parent)) return { links, end: { kind: 'cycle', name: parent } };
    if (links.length >= MAX_CHAIN_DEPTH) return { links, end: { kind: 'tooDeep' } };
    seen.add(parent);

    // Annotated: `parent` is reassigned from `next` below, so tsc can't infer this (TS7022).
    const next: ResolvedPreset | null = inSystem
      ? systemOnlyLookup(parent, ctx)
      : resolveParent(parent, ctx);
    if (!next) return { links, end: { kind: 'missing', name: parent, referencedBy: child } };
    links.push(next);
    inSystem = next.kind === 'system';
    child = parent;
    parent = inheritsOf(next);
  }
  return { links, end: { kind: 'root' } };
}

function systemOnlyLookup(name: string, ctx: ResolveContext): ResolvedPreset | null {
  const entry = ctx.system.get(name);
  return entry ? { kind: 'system', name, entry } : null;
}

function inheritsOf(r: ResolvedPreset): string {
  return r.kind === 'system' ? (r.entry.inherits ?? '') : userInherits(r.preset);
}
