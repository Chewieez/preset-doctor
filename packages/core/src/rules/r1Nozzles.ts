/**
 * Nozzle evidence for R1: which nozzle sizes a missing parent was for, and which a candidate
 * covers. Nothing here is printer-specific; conventions are read from the system profile.
 *
 * Why this is needed: a name without a nozzle size means different things per printer and even
 * per filament. In 02.08.00.06 every unsuffixed X2D preset is for the 0.6/0.8 nozzle, H2C ones
 * are mostly 0.6/0.8, X1C and A1 ones are 0.4 or 0.4/0.6/0.8. Assuming 0.4 for such a name
 * pre-selected the wrong nozzle in about one case in eight (scripts/r1-simulate.ts).
 */
import {
  DEFAULT_NOZZLE,
  parseCompatiblePrinter,
  sameNozzle,
  type ParsedPresetName,
} from '../names.js';
import type { SystemIndex } from '../systemIndex.js';

/** Nozzle sizes used by a printer's presets whose names carry no size. */
export interface UnsuffixedConvention {
  /** Every size any of them lists, smallest first. */
  any: string[];
  /** Sizes all of them list, smallest first (may be empty). */
  all: string[];
  /** Every size any preset for this printer lists, with or without a size in its name. */
  printer: string[];
}

/** Distinct nozzle sizes listed for one printer model, in list order. */
export function nozzlesFor(compat: readonly string[], model: string): string[] {
  const out: string[] = [];
  for (const entry of compat) {
    const cp = parseCompatiblePrinter(entry);
    if (cp && cp.model === model && !out.some((n) => sameNozzle(n, cp.nozzle))) {
      out.push(cp.nozzle);
    }
  }
  return out;
}

/** compatible_printers as written in a preset's own JSON, if it is a list of strings. */
export function ownCompat(
  json: Record<string, unknown> | undefined,
): readonly string[] | undefined {
  const v = json?.['compatible_printers'];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

/** True when every size in `needed` is in `have`. */
export function coversAll(have: readonly string[], needed: readonly string[]): boolean {
  return needed.every((t) => have.some((n) => sameNozzle(n, t)));
}

/** Union of sizes, smallest first, duplicates (by value) removed. */
export function sortedNozzles(sizes: Iterable<string>): string[] {
  const out: string[] = [];
  for (const s of sizes) if (!out.some((n) => sameNozzle(n, s))) out.push(s);
  return out.sort((a, b) => Number(a) - Number(b));
}

const conventionCache = new WeakMap<
  SystemIndex,
  Map<string, Promise<UnsuffixedConvention | null>>
>();

/**
 * What an unsuffixed name means for this printer: the nozzle sizes of every instantiable system
 * preset of the same vendor tag and printer code (or, for wizard names that spell out the model,
 * the same model) whose name has no size. Null when there is no such preset with a known size,
 * i.e. the profile says nothing. Cached per index.
 */
export function unsuffixedConvention(
  parsed: ParsedPresetName,
  model: string,
  system: SystemIndex,
): Promise<UnsuffixedConvention | null> {
  let perIndex = conventionCache.get(system);
  if (!perIndex) {
    perIndex = new Map();
    conventionCache.set(system, perIndex);
  }
  const key =
    parsed.model === undefined
      ? `code\u0000${(parsed.vendorTag ?? '').toLowerCase()}\u0000${(parsed.printerCode ?? '').toLowerCase()}\u0000${model}`
      : `model\u0000${model}`;
  let p = perIndex.get(key);
  if (!p) {
    p = computeConvention(parsed, model, system);
    perIndex.set(key, p);
  }
  return p;
}

async function computeConvention(
  parsed: ParsedPresetName,
  model: string,
  system: SystemIndex,
): Promise<UnsuffixedConvention | null> {
  if (parsed.printerCode === undefined) return null;
  const tag = parsed.vendorTag?.toLowerCase();
  const code = parsed.printerCode.toLowerCase();
  const sets: string[][] = [];
  const printer: string[] = [];
  for (const name of system.names()) {
    const pn = system.parsed(name);
    if (!pn || pn.printerCode === undefined || pn.model !== undefined) continue;
    if (parsed.model === undefined) {
      if (pn.vendorTag?.toLowerCase() !== tag || pn.printerCode.toLowerCase() !== code) continue;
    } else if ((await system.modelOf(pn)) !== model) {
      continue;
    }
    const body = await system.load(name);
    if (!body?.instantiation) continue;
    const sizes = nozzlesFor((await system.effectiveCompatiblePrinters(name)) ?? [], model);
    printer.push(...sizes);
    if (pn.nozzle === undefined && sizes.length > 0) sets.push(sizes);
  }
  if (sets.length === 0) return null;
  const any = sortedNozzles(sets.flat());
  const all = any.filter((n) => sets.every((s) => s.some((x) => sameNozzle(x, n))));
  return { any, all, printer: sortedNozzles(printer) };
}

/**
 * Sizes an unsuffixed name could stand for, all of which a candidate has to cover before it is
 * safe to pick without asking. When every such preset of the printer is for the 0.4 nozzle alone,
 * that is the convention: 0.4. Otherwise the size is anyone's guess (a renamed preset may have
 * been for any nozzle the printer takes), so every size the printer's presets list, plus 0.4.
 * Null when the profile has no unsuffixed preset for the printer to learn from.
 */
export function possibleUnsuffixedNozzles(c: UnsuffixedConvention | null): string[] | null {
  if (!c) return null;
  if (c.any.length === 1 && sameNozzle(c.any[0]!, DEFAULT_NOZZLE)) return [DEFAULT_NOZZLE];
  return sortedNozzles([...c.printer, ...c.any, DEFAULT_NOZZLE]);
}

/**
 * Sizes an unsuffixed name surely stands for, used only when a candidate's compatibility is
 * unknown. Without data, the spec's default (0.4).
 */
export function certainUnsuffixedNozzles(c: UnsuffixedConvention | null): string[] {
  return c ? c.all : [DEFAULT_NOZZLE];
}
