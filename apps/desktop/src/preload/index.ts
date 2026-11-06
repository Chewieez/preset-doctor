// Runs sandboxed: only `electron`'s contextBridge/ipcRenderer are available, and everything
// else is bundled in. Exposes exactly the calls in PresetDoctorApi, nothing more.
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type PresetDoctorApi } from '../shared/api.js';

const api: PresetDoctorApi = {
  getConfig: () => ipcRenderer.invoke(CHANNELS.getConfig),
  scan: (root, userId) => ipcRenderer.invoke(CHANNELS.scan, root, userId),
  plan: (choices, options) => ipcRenderer.invoke(CHANNELS.plan, choices, options),
  apply: (planId) => ipcRenderer.invoke(CHANNELS.apply, planId),
  listBackups: () => ipcRenderer.invoke(CHANNELS.listBackups),
  restore: (root, backupId, options) =>
    ipcRenderer.invoke(CHANNELS.restore, root, backupId, options),
  studioStatus: () => ipcRenderer.invoke(CHANNELS.studioStatus),
  pickFolder: () => ipcRenderer.invoke(CHANNELS.pickFolder),
  openBackupsFolder: () => ipcRenderer.invoke(CHANNELS.openBackupsFolder),
  openDonationPage: () => ipcRenderer.invoke(CHANNELS.openDonationPage),
};

contextBridge.exposeInMainWorld('presetDoctor', api);
