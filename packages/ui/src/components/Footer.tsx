import { api } from '../api';

interface Props {
  version: string;
  donationUrl: string;
  onRestore: () => void;
}

export function Footer({ version, donationUrl, onRestore }: Props) {
  return (
    <footer className="footer">
      <button type="button" className="btn" onClick={onRestore} data-testid="open-backups">
        Restore a backup…
      </button>
      <span className="footer-note">No data leaves your computer.</span>
      <span className="footer-note">
        Not affiliated with or endorsed by Bambu Lab or the OrcaSlicer project.
      </span>
      <span className="footer-spacer" />
      {donationUrl !== '' && (
        <button
          type="button"
          className="btn link"
          // The raw IpcResult never rejects, and a failed opener has nothing to show.
          onClick={() => void api.openDonationPage()}
        >
          Support this project
        </button>
      )}
      <span className="muted">v{version}</span>
    </footer>
  );
}
