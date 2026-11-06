import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../shared/api.js';

type Listener = (event: unknown, ...args: unknown[]) => unknown;
const listeners = new Map<string, Listener>();

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Listener) => listeners.set(channel, fn) },
  dialog: {},
  shell: {},
}));

const { registerIpc } = await import('./ipc.js');
type Service = Parameters<typeof registerIpc>[0];
type Window = NonNullable<ReturnType<Parameters<typeof registerIpc>[1]>>;

const mainFrame = {};
const webContents = { mainFrame };
const win = { webContents } as unknown as Window;
const fromApp = { sender: webContents, senderFrame: mainFrame };

function register(service: Partial<Service>): void {
  listeners.clear();
  registerIpc(service as Service, () => win, '');
}

describe('registerIpc', () => {
  beforeEach(() => listeners.clear());

  it('turns a handler that throws before returning a promise into an IpcResult', async () => {
    register({
      scan: () => {
        throw new Error('bad arguments');
      },
    });
    await expect(listeners.get(CHANNELS.scan)!(fromApp, 'root', 'id')).resolves.toEqual({
      ok: false,
      error: { code: 'failed', message: 'bad arguments' },
    });
  });

  it('turns a rejected promise into an IpcResult', async () => {
    register({ listBackups: () => Promise.reject(new Error('disk gone')) });
    await expect(listeners.get(CHANNELS.listBackups)!(fromApp)).resolves.toEqual({
      ok: false,
      error: { code: 'failed', message: 'disk gone' },
    });
  });

  it('refuses requests from any other page', async () => {
    const studioStatus = vi.fn();
    register({ studioStatus });
    const other = { sender: {}, senderFrame: mainFrame };
    await expect(listeners.get(CHANNELS.studioStatus)!(other)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    expect(studioStatus).not.toHaveBeenCalled();
  });
});
