import { app, BrowserWindow, Menu } from 'electron';
import * as nodePath from 'node:path';
import { slicerById } from '@preset-doctor/core';
import { defaultPaths, isSlicerRunning } from '@preset-doctor/core/node';
import { APP_NAME, DONATION_URL, WINDOW_TITLE } from '../shared/constants.js';
import iconPath from '../../resources/icon.png?asset';
import { readConfig } from './config.js';
import { registerIpc } from './ipc.js';
import { hardenApp } from './security.js';
import { DoctorService } from './service.js';

const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;

app.setName(APP_NAME);
// Lets tests keep Electron's own cache and settings out of the real profile.
if (process.env.PRESET_DOCTOR_USER_DATA)
  app.setPath('userData', process.env.PRESET_DOCTOR_USER_DATA);

hardenApp(devServerUrl);

const config = readConfig(process.env, defaultPaths());
const service = new DoctorService({
  config,
  isStudioRunning: (slicer) => isSlicerRunning(slicerById(slicer)),
  version: app.getVersion(),
  donationUrl: DONATION_URL,
});

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: WINDOW_TITLE,
    icon: iconPath,
    show: false,
    backgroundColor: '#f6f7f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: nodePath.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => (mainWindow = null));

  if (devServerUrl) void mainWindow.loadURL(devServerUrl);
  else void mainWindow.loadFile(nodePath.join(__dirname, '../renderer/index.html'));
}

function setupMenu(): void {
  if (process.platform === 'darwin') {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    Menu.setApplicationMenu(null);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  void app.whenReady().then(() => {
    setupMenu();
    registerIpc(service, () => mainWindow, DONATION_URL);
    createWindow();
  });
  app.on('activate', () => {
    if (mainWindow === null) createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
