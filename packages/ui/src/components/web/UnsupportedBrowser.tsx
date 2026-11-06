import { DesktopAppLink } from './DesktopAppLink';

/** Web only: shown instead of the app when the browser can't open folders. */
export function UnsupportedBrowser() {
  return (
    <div className="app">
      <main className="content">
        <div className="intro" data-testid="unsupported-browser">
          <img className="logo" src="./icon.png" alt="" width={56} height={56} />
          <h2>This browser can't open folders</h2>
          <p>
            Preset Doctor's web version needs folder access (the File System Access API), which only
            Chromium browsers have. Open this page in <strong>Google Chrome</strong> or{' '}
            <strong>Microsoft Edge</strong> on a computer, or use the Windows app, which repairs
            your presets in place without copying folders.
          </p>
          <p>
            <DesktopAppLink />
          </p>
          <p className="footer-note">
            No data leaves your computer. Not affiliated with or endorsed by Bambu Lab.
          </p>
        </div>
      </main>
    </div>
  );
}
