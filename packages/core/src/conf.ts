import { errorMessage, isNotFound, type PresetFs } from './fs.js';
import { isRecord, stripBom } from './jsonFile.js';
import type { SlicerProfile } from './slicer.js';

/** Root-relative path of Studio's app config. */
export const STUDIO_CONF_PATH = 'BambuStudio.conf';

/** One entry of the conf's "models" section: a printer model and its added nozzle sizes. */
export interface EnabledModel {
  /** Vendor id: the vendor index's file name without .json, e.g. 'BBL'. */
  vendor: string;
  /** printer_model, e.g. 'Bambu Lab X2D'. */
  model: string;
  /** printer_variant values, from "0.2;0.4;0.6", as written. */
  nozzles: string[];
}

/** What Preset Doctor reads from the slicer's app config. */
export interface SlicerConf {
  /** False when the file does not exist. */
  found: boolean;
  /** app.sync_user_preset: Studio's cloud preset sync (SPEC section 10, question 3). */
  syncUserPreset?: boolean;
  /** presets.machine: the selected printer preset. */
  selectedPrinter?: string;
  /** presets.process: the selected process preset. */
  selectedProcess?: string;
  /** models[]: the printers added in the slicer. An empty array is a real value. */
  enabledModels?: EnabledModel[];
  /** Why the file could not be read or parsed, if so. The values above may still be filled in. */
  error?: string;
  /** OrcaSlicer: the top-level "header", e.g. 'OrcaSlicer 2.3.2-rc'. */
  header?: string;
  /** OrcaSlicer 2.5: app.cloud_providers split at ';', e.g. ['orca', 'bbl']. */
  cloudProviders?: string[];
  /** OrcaSlicer 2.4+: app.show_unsupported_presets (Preferences > Developer). */
  showUnsupportedPresets?: boolean;
  /** OrcaSlicer: app.preset_folder, the account folder in use ('' means user/default). */
  presetFolder?: string;
}

/** The old name, kept for existing imports. */
export type StudioConf = SlicerConf;

/**
 * Reads the app config of the given slicer (see readStudioConf). OrcaSlicer.conf has the same
 * format: JSON, then "# MD5 checksum <hex>"; Orca's own reader cuts at the last "}" and the
 * checksum is optional (src/libslic3r/AppConfig.cpp:741-774@v2.5.0).
 */
export function readSlicerConf(fs: PresetFs, profile: SlicerProfile): Promise<SlicerConf> {
  return readStudioConf(fs, profile.confFile);
}

/**
 * Reads BambuStudio.conf, or with `path` any slicer's conf (OrcaSlicer.conf too; the Studio
 * names are kept for existing imports). Never throws: the file may be missing, huge, mid-write
 * by Studio, or followed by the "# MD5 checksum ..." line Studio appends after the JSON
 * (src/libslic3r/AppConfig.cpp:575-578@v02.09.01.70).
 */
export async function readStudioConf(
  fs: PresetFs,
  path: string = STUDIO_CONF_PATH,
): Promise<StudioConf> {
  let text: string;
  try {
    text = await fs.readText(path);
  } catch (err) {
    if (isNotFound(err)) return { found: false };
    return { found: true, error: `Could not read ${path}: ${errorMessage(err)}` };
  }
  return parseStudioConf(text, path);
}

/** `fileName` only names the file in error messages. */
export function parseStudioConf(text: string, fileName: string = STUDIO_CONF_PATH): StudioConf {
  const json = stripTrailer(stripBom(text));
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    // A damaged or half-written file: still try to find the one flag we care about.
    const conf: StudioConf = {
      found: true,
      error: `${fileName} is not valid JSON: ${errorMessage(err)}`,
    };
    const m = /"sync_user_preset"\s*:\s*("?)(true|false|1|0)\1/.exec(json);
    const sync = m ? toBool(m[2]) : undefined;
    if (sync !== undefined) conf.syncUserPreset = sync;
    return conf;
  }
  const conf: StudioConf = { found: true };
  if (isRecord(value)) {
    readPrinters(value, conf);
    if (typeof value['header'] === 'string') conf.header = value['header'];
  }
  const app = isRecord(value) ? value['app'] : undefined;
  if (!isRecord(app)) return { ...conf, error: `No "app" section in ${fileName}.` };
  const sync = toBool(app['sync_user_preset']);
  if (sync !== undefined) conf.syncUserPreset = sync;
  readOrcaApp(app, conf);
  return conf;
}

/**
 * OrcaSlicer's own app keys: cloud_providers (2.5, src/libslic3r/AppConfig.cpp:1024-1031@v2.5.0),
 * show_unsupported_presets (2.4+, :455-456) and preset_folder
 * (src/libslic3r/PresetBundle.cpp:900-905@v2.5.0). Bambu Studio's conf has none of them.
 */
function readOrcaApp(app: Record<string, unknown>, conf: StudioConf): void {
  const providers = app['cloud_providers'];
  if (typeof providers === 'string') {
    conf.cloudProviders = providers
      .split(';')
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p !== '');
  }
  const show = toBool(app['show_unsupported_presets']);
  if (show !== undefined) conf.showUnsupportedPresets = show;
  if (typeof app['preset_folder'] === 'string') conf.presetFolder = app['preset_folder'];
}

/**
 * The selected printer and process, and the added printers. Only these keys are read: the conf
 * also holds device access codes, serials and account details, which Preset Doctor never touches.
 * Studio reads "presets" at src/libslic3r/PresetBundle.cpp:2157-2172@v02.09.01.70 and "models"
 * at src/libslic3r/AppConfig.cpp:696-707@v02.09.01.70 (matched by get_variant, :1199-1205).
 */
function readPrinters(value: Record<string, unknown>, conf: StudioConf): void {
  const presets = value['presets'];
  if (isRecord(presets)) {
    const machine = presetName(presets['machine']);
    if (machine !== undefined) conf.selectedPrinter = machine;
    const process = presetName(presets['process']);
    if (process !== undefined) conf.selectedProcess = process;
    else if (machine !== undefined) {
      // OrcaSlicer remembers the process per printer in "orca_presets"
      // (src/libslic3r/AppConfig.cpp:943-949@v2.5.0); its "presets" may hold only the printer.
      const remembered = value['orca_presets'];
      const hit = Array.isArray(remembered)
        ? remembered.find((r) => isRecord(r) && presetName(r['machine']) === machine)
        : undefined;
      const fromHit = isRecord(hit) ? presetName(hit['process']) : undefined;
      if (fromHit !== undefined) conf.selectedProcess = fromHit;
    }
  }
  const models = value['models'];
  if (Array.isArray(models)) {
    const out: EnabledModel[] = [];
    for (const m of models) {
      if (!isRecord(m) || typeof m['model'] !== 'string') continue;
      const vendor = typeof m['vendor'] === 'string' ? m['vendor'] : '';
      const nozzles =
        typeof m['nozzle_diameter'] === 'string'
          ? m['nozzle_diameter'].split(';').filter((n) => n !== '')
          : [];
      out.push({ vendor, model: m['model'], nozzles });
    }
    conf.enabledModels = out;
  }
}

/** A preset name from the "presets" section, without the ".ini" suffix Studio also strips. */
function presetName(v: unknown): string | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  return v.toLowerCase().endsWith('.ini') ? v.slice(0, -'.ini'.length) : v;
}

/** Drops trailing lines that start with '#', e.g. "# MD5 checksum 184F...". */
function stripTrailer(text: string): string {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0) {
    const last = lines[lines.length - 1]!.trim();
    if (last === '' || last.startsWith('#')) lines.pop();
    else break;
  }
  return lines.join('\n');
}

// Older Studio versions stored booleans as strings or numbers.
function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return undefined;
}
