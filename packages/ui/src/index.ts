// The shared Preset Doctor screen. Each app provides `window.presetDoctor` (see contract.ts)
// before this module loads, then calls mount().
export { mount, type MountView } from './mount';
export type * from './contract';
