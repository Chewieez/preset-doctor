// Browser-safe public API. Node-only adapters are exported from './node/index.js'.
export const VERSION = '0.2.0';

export * from './types.js';
export * from './terms.js';
export {
  BAMBU,
  detectSlicer,
  ORCA,
  ORCA_LIBRARY,
  parseVersion,
  slicerById,
  slicerFolder,
  SLICERS,
  type SlicerDetection,
  type SlicerProfile,
  type VendorPlan,
} from './slicer.js';
export * from './opc.js';
export * from './orcaLookup.js';
export * from './fs.js';
export { memFs, type MemFs } from './memFs.js';
export * from './jsonFile.js';
export * from './infoFile.js';
export * from './backup.js';
export * from './userScan.js';
export * from './resolve.js';
export * from './conf.js';
export * from './names.js';
export * from './systemIndex.js';
export * from './compat.js';
export * from './rules/context.js';
export * from './rules/r1.js';
export * from './rules/r2r3.js';
export * from './rules/r4.js';
export * from './scan.js';
export * from './fix.js';
export * from './diff.js';
