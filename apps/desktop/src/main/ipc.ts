import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { errorMessage } from '@preset-doctor/core';
import { CHANNELS, type IpcResult } from '../shared/api.js';
import type { DoctorService } from './service.js';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<IpcResult<unknown>>;

/** Wires every channel in CHANNELS to the service. Only the app's own window may call them. */
export function registerIpc(
  service: DoctorService,
  getWindow: () => BrowserWindow | null,
  donationUrl: string,
): void {
  const handlers: Record<keyof typeof CHANNELS, Handler> = {
    getConfig: () => service.getConfig(),
    scan: (_e, root, userId) => service.scan(root, userId),
    plan: (_e, choices, options) => service.plan(choices, options),
    apply: (_e, planId) => service.apply(planId),
    listBackups: () => service.listBackups(),
    restore: (_e, root, id, options) => service.restore(root, id, options),
    studioStatus: () => service.studioStatus(),
    pickFolder: async () => {
      const win = getWindow();
      const options: Electron.OpenDialogOptions = {
        title: 'Choose the Bambu Studio data folder',
        properties: ['openDirectory'],
      };
      const picked = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      const first = picked.filePaths[0];
      if (picked.canceled || !first) return { ok: true, value: null };
      return { ok: true, value: await service.adoptFolder(first) };
    },
    openBackupsFolder: async () => {
      const dir = await service.ensureBackupsDir();
      const error = await shell.openPath(dir);
      return error
        ? { ok: false, error: { code: 'failed', message: error } }
        : { ok: true, value: undefined };
    },
    openDonationPage: async () => {
      // Opens the user's own browser; the app itself still makes no requests.
      if (!donationUrl.startsWith('https://')) {
        return { ok: false, error: { code: 'invalid', message: 'No donation link is set.' } };
      }
      await shell.openExternal(donationUrl);
      return { ok: true, value: undefined };
    },
  };

  for (const [name, handler] of Object.entries(handlers) as [keyof typeof CHANNELS, Handler][]) {
    ipcMain.handle(CHANNELS[name], async (event, ...args): Promise<IpcResult<unknown>> => {
      const win = getWindow();
      if (
        !win ||
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame
      ) {
        return { ok: false, error: { code: 'invalid', message: 'Request from an unknown page.' } };
      }
      // An IpcResult, never a rejection: the UI relies on that (e.g. shell.openExternal or
      // mkdir throwing would otherwise surface as an unhandled rejection in the window). The
      // await inside try also catches a handler that throws before returning its promise.
      try {
        return await handler(event, ...args);
      } catch (err) {
        return { ok: false, error: { code: 'failed', message: errorMessage(err) } };
      }
    });
  }
}
