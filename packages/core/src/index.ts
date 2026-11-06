// Browser-safe public API. Node-only adapters are exported from './node/index.js'.
export const VERSION = '0.1.0';

export * from './types.js';
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
export * from './rules/context.js';
export * from './rules/r1.js';
export * from './rules/r4.js';
export * from './scan.js';
export * from './fix.js';
