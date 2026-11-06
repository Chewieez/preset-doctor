// Provides `window.presetDoctor` for the shared UI. main.tsx imports this module first, so the
// API exists before @preset-doctor/ui reads it.
import type { PresetDoctorApi } from '@preset-doctor/ui/contract';
import { BrowserDoctor } from './browserDoctor';
import { saveDownload } from './download';
import { directoryPicker } from './fsaTypes';
import { indexedDbHandleStore } from './handleStore';

declare global {
  interface Window {
    presetDoctor: PresetDoctorApi;
  }
}

declare const __APP_VERSION__: string;

export const folderAccessSupported = directoryPicker() !== undefined;

window.presetDoctor = new BrowserDoctor({
  showDirectoryPicker: directoryPicker(),
  handles: indexedDbHandleStore(),
  download: saveDownload,
  version: __APP_VERSION__,
});
