import { RELEASES_URL } from '../../links';

/** Points web users at the Windows app, which repairs in place without copying folders. */
export function DesktopAppLink() {
  return (
    <a
      className="btn app-link"
      href={RELEASES_URL}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="desktop-app-link"
    >
      Prefer one click? Download the Windows app
    </a>
  );
}
