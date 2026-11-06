import type { ResolveContext } from '../resolve.js';
import type { SystemIndex } from '../systemIndex.js';
import type { UserPreset } from '../types.js';

/** Everything a rule may look at. Built once per scan. */
export interface RuleContext {
  system: SystemIndex;
  /**
   * Lookups for walking inherits. Its system side answers by name only: the index itself, or (in
   * a scan) studioNameLookup, which uses the names Studio does. Its entries' `name` is always the
   * index name, which is what the SystemIndex methods take.
   */
  resolve: ResolveContext;
  /** All presets of the scanned account. */
  presets: readonly UserPreset[];
}
