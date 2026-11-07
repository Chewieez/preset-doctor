import type { OrcaLookup } from '../orcaLookup.js';
import type { ResolveContext } from '../resolve.js';
import type { SlicerProfile } from '../slicer.js';
import type { SystemIndex } from '../systemIndex.js';
import type { PresetType, UserPreset } from '../types.js';

/**
 * Everything a rule may look at. Built once per scan and preset type: parents only resolve within
 * the same type, because Studio keeps each type in its own collection
 * (src/libslic3r/PresetBundle.cpp:917, 924, 931@v02.09.01.70).
 */
export interface RuleContext {
  /** The type of every preset in `presets`. Default 'filament'. */
  type?: PresetType;
  /** The slicer. Default BAMBU. */
  profile?: SlicerProfile;
  /** The system index of this type. */
  system: SystemIndex;
  /**
   * Lookups for walking inherits. Its system side answers by name only: the index itself, or (in
   * a scan) studioNameLookup, which uses the names Studio does. Its entries' `name` is always the
   * index name, which is what the SystemIndex methods take.
   */
  resolve: ResolveContext;
  /** All presets of this type in the scanned account. */
  presets: readonly UserPreset[];
  /**
   * OrcaSlicer only: how each parent name was found (renamed, "Generic" fallback, packed .opc).
   * `resolve.system` is this same lookup.
   */
  orca?: OrcaLookup;
}
