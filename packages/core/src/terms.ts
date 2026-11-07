/**
 * Wording that depends on the preset type. The filament strings are exactly the ones Preset
 * Doctor used before it knew other types, so filament output stays byte-identical. The UI keeps
 * its own copy (packages/ui/src/model.ts), because it imports only types from core.
 */
import type { PresetType } from './types.js';

/**
 * The key Studio sets to the preset's own name when it saves one: a one-item array for filament,
 * a plain string for process and printer presets
 * (src/libslic3r/Preset.cpp:2697-2703, 2748-2754@v02.09.01.70).
 */
export type SettingsIdKey =
  | { key: 'filament_settings_id'; shape: 'array0' }
  | { key: 'print_settings_id'; shape: 'string' }
  | { key: 'printer_settings_id'; shape: 'string' };

export interface TypeTerms {
  /** 'filament preset' | 'process preset' | 'printer preset' */
  noun: string;
  /** 'Filament' | 'Process' | 'Printer' */
  tab: string;
  /** Where Studio shows the preset: 'filament list' | 'process list' | 'printer list'. */
  list: string;
  /** Tag for base/ presets: 'custom filament' | 'custom process' | 'custom printer'. */
  baseTag: string;
  /** Row reason for a base/ preset without a parent. */
  rootReason: string;
  settingsIdKey: SettingsIdKey;
}

export const TERMS: Record<PresetType, TypeTerms> = {
  filament: {
    noun: 'filament preset',
    tab: 'Filament',
    list: 'filament list',
    baseTag: 'custom filament',
    rootReason: 'Custom filament, not based on another preset',
    settingsIdKey: { key: 'filament_settings_id', shape: 'array0' },
  },
  process: {
    noun: 'process preset',
    tab: 'Process',
    list: 'process list',
    baseTag: 'custom process',
    rootReason: 'Custom process, not based on another preset',
    settingsIdKey: { key: 'print_settings_id', shape: 'string' },
  },
  machine: {
    noun: 'printer preset',
    tab: 'Printer',
    list: 'printer list',
    baseTag: 'custom printer',
    rootReason: 'Custom printer, not based on another preset',
    settingsIdKey: { key: 'printer_settings_id', shape: 'string' },
  },
};
