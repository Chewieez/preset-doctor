/**
 * Walks `inherits` links between presets.
 *
 * In Bambu Studio a user preset may inherit from a system preset or from another user preset
 * of the same account (including wizard presets in filament/base/). System presets only ever
 * inherit from other system presets.
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
}

export interface SystemLookup {
  get(name: string): SystemPresetLike | undefined;
}

export interface ResolveContext {
  system: SystemLookup;
  /** User presets of the scanned account, keyed by name (see buildUserIndex). */
  userByName: ReadonlyMap<string, UserPreset>;
}

export type ResolvedPreset =
  | { kind: 'system'; name: string; entry: SystemPresetLike }
  | { kind: 'user'; name: string; preset: UserPreset };

/** Safety net for absurdly long chains; real chains are under 10 links. */
const MAX_CHAIN_DEPTH = 64;

/**
 * Indexes user presets by their `name` field, and also by file name when that differs, so a
 * preset with a name/file mismatch (R4) does not also make its children look orphaned. The
 * first preset wins on duplicates; top-level presets come before base/ ones from scanUser.
 */
export function buildUserIndex(presets: readonly UserPreset[]): Map<string, UserPreset> {
  const byName = new Map<string, UserPreset>();
  for (const p of presets) {
    const name = presetName(p);
    if (name !== undefined && !byName.has(name)) byName.set(name, p);
  }
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
  const seen = new Set<string>([startName]);
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
