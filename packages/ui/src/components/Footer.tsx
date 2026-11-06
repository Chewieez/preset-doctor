import { api, call } from '../api';

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
      <span className="footer-note">Not affiliated with or endorsed by Bambu Lab.</span>
      <span className="footer-spacer" />
      {donationUrl !== '' && (
        <button
          type="button"
          className="btn link"
          onClick={() => void call(api.openDonationPage())}
        >
          Support this project
        </button>
      )}
      <span className="muted">v{version}</span>
    </footer>
  );
}
