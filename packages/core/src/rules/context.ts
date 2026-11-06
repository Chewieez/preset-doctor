import type { ResolveContext } from '../resolve.js';
import type { SystemIndex } from '../systemIndex.js';
import type { UserPreset } from '../types.js';

/** Everything a rule may look at. Built once per scan. */
export interface RuleContext {
  system: SystemIndex;
  /** Lookups for walking inherits. Its system side is the index itself (names only). */
  resolve: ResolveContext;
  /** All presets of the scanned account. */
  presets: readonly UserPreset[];
}
