import { app, session, type WebContents } from 'electron';

/**
 * Locks the app down: no navigation, no new windows, no permissions, and no network. The only
 * requests allowed are for the app's own files (and the dev server while developing).
 */
export function hardenApp(devServerUrl: string | undefined): void {
  app.enableSandbox();

  app.on('web-contents-created', (_event, contents) => lockContents(contents));

  app.whenReady().then(() => {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isAllowedUrl(details.url, devServerUrl) });
    });
  });
}

export function isAllowedUrl(url: string, devServerUrl: string | undefined): boolean {
  if (url.startsWith('file:') || url.startsWith('devtools:') || url.startsWith('data:')) {
    return true;
  }
  if (devServerUrl) {
    const dev = new URL(devServerUrl);
    try {
      const u = new URL(url);
      if (u.host === dev.host && (u.protocol === 'http:' || u.protocol === 'ws:')) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function lockContents(contents: WebContents): void {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
