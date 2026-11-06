/**
 * Preset-name parsing. Bambu Studio links a user preset to its parent purely by name, so R1 has
 * to understand the naming scheme to suggest replacements. Observed shapes (profile 02.08.00.06):
 *
 *   Generic PLA @BBL X2D                 stem + vendor tag + printer code (nozzle implied)
 *   Generic PLA @BBL X2D 0.6 nozzle      ... + explicit nozzle
 *   My PLA @Bambu Lab A1 mini 0.4 nozzle wizard presets: full printer model instead of a code
 *   Generic ABS @0.2 nozzle              nozzle only, no printer
 *   Generic PLA                          no tag at all
 *   Generic PLA @base, fdm_filament_pla  non-instantiable building blocks (parse to null)
 *
 * Nothing printer-specific is hardcoded here: mapping a code like "X1C" to the model
 * "Bambu Lab X1 Carbon" is done from data in systemIndex.ts.
 */

export interface ParsedPresetName {
  /** Filament part before " @", e.g. "Generic PLA". The whole name when there is no tag. */
  stem: string;
  /** "BBL" for system names, "Bambu Lab" for wizard names. */
  vendorTag?: string;
  /** "X2D", "A1M", "H2DP"; for wizard names the model part after the vendor, e.g. "A1 mini". */
  printerCode?: string;
  /** Full printer model when the name spells it out (wizard names), e.g. "Bambu Lab A1 mini". */
  model?: string;
  /** Explicit nozzle diameter as written, e.g. "0.4". Absent when the name has no suffix. */
  nozzle?: string;
}

export interface ParsedCompatiblePrinter {
  /** "Bambu Lab X2D" */
  model: string;
  /** "0.6" */
  nozzle: string;
}

/** Vendor names that wizard presets write in full before the model ("@Bambu Lab X2D ..."). */
const FULL_VENDOR_NAMES = ['Bambu Lab'];

const NOZZLE_SUFFIX_RE = /^(?:(.*) )?(\d+(?:\.\d+)?) nozzle$/;
const COMPATIBLE_PRINTER_RE = /^(.+) (\d+(?:\.\d+)?) nozzle$/;
const TEMPLATE_RE = /^fdm_\w+$/;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9+-]*$/;

/** The implied nozzle when a name has no suffix and nothing else says otherwise. */
export const DEFAULT_NOZZLE = '0.4';

/** Templates such as "fdm_filament_pla": never shown in Studio, only inherited from. */
export function isTemplateName(name: string): boolean {
  return TEMPLATE_RE.test(name);
}

/** "Generic PLA @base": the per-filament building block that printer variants inherit from. */
export function isBaseName(name: string): boolean {
  return name.endsWith(' @base');
}

/**
 * Splits a preset name into its parts. Returns null for templates and "@base" presets, which
 * have no printer and never need repairing. Never throws; a name with an unrecognized tail
 * (e.g. "Foo @BBL X2D 0.4 nozzle - Copy") comes back as a bare stem equal to the whole name.
 */
export function parsePresetName(name: string): ParsedPresetName | null {
  if (isTemplateName(name) || isBaseName(name)) return null;

  const at = name.lastIndexOf(' @');
  if (at < 0) return { stem: name };
  const stem = name.slice(0, at);
  const tail = name.slice(at + 2);
  if (stem.trim() === '') return { stem: name };

  const nozzleMatch = NOZZLE_SUFFIX_RE.exec(tail);
  const printerPart = nozzleMatch ? (nozzleMatch[1] ?? '') : tail;
  const nozzle = nozzleMatch?.[2];
  const withNozzle = (p: ParsedPresetName): ParsedPresetName =>
    nozzle === undefined ? p : { ...p, nozzle };

  if (printerPart === '') return nozzle === undefined ? { stem: name } : withNozzle({ stem });

  for (const vendor of FULL_VENDOR_NAMES) {
    if (printerPart === vendor) return withNozzle({ stem, vendorTag: vendor });
    if (!printerPart.startsWith(vendor + ' ')) continue;
    const code = printerPart.slice(vendor.length + 1);
    if (code.split(' ').every((t) => CODE_RE.test(t))) {
      return withNozzle({ stem, vendorTag: vendor, printerCode: code, model: printerPart });
    }
  }

  const tokens = printerPart.split(' ');
  const [vendorTag, printerCode] = tokens;
  if (
    tokens.length === 2 &&
    vendorTag !== undefined &&
    printerCode !== undefined &&
    CODE_RE.test(vendorTag) &&
    CODE_RE.test(printerCode)
  ) {
    return withNozzle({ stem, vendorTag, printerCode });
  }
  return { stem: name };
}

/** "Bambu Lab X2D 0.6 nozzle" -> { model: "Bambu Lab X2D", nozzle: "0.6" }; null otherwise. */
export function parseCompatiblePrinter(entry: string): ParsedCompatiblePrinter | null {
  const m = COMPATIBLE_PRINTER_RE.exec(entry);
  if (!m?.[1] || !m[2]) return null;
  return { model: m[1], nozzle: m[2] };
}

export function compatiblePrinterName(model: string, nozzle: string): string {
  return `${model} ${nozzle} nozzle`;
}

/** Normalizes "0.40" / "0.4" so nozzle sizes compare by value. */
export function sameNozzle(a: string, b: string): boolean {
  return Number(a) === Number(b);
}

/**
 * The spec's first-tier guess: add " 0.4 nozzle" if absent, strip it if present.
 * Returns null when the name has a different explicit nozzle or no printer part.
 */
export function toggleDefaultNozzleSuffix(name: string): string | null {
  const suffix = ` ${DEFAULT_NOZZLE} nozzle`;
  if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  const parsed = parsePresetName(name);
  if (!parsed?.printerCode || parsed.nozzle !== undefined) return null;
  return name + suffix;
}

/**
 * Short codes a model name could be abbreviated to, used to match "X1C" with
 * "Bambu Lab X1 Carbon" without a hardcoded table: for every suffix of the words, the first word
 * plus the initials of the rest ("X1 Carbon" -> "X1C", "A1 mini" -> "A1M", "H2D Pro" -> "H2DP").
 * Upper-cased.
 */
export function modelAbbreviations(model: string): string[] {
  const words = model.split(' ').filter((w) => w !== '');
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const [first, ...rest] = words.slice(i);
    if (first === undefined) continue;
    out.add((first + rest.map((w) => w[0] ?? '').join('')).toUpperCase());
  }
  return [...out];
}

export function modelMatchesCode(model: string, code: string): boolean {
  return modelAbbreviations(model).includes(code.toUpperCase());
}
