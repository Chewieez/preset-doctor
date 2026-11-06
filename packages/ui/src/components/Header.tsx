import type { AccountSummary } from '@preset-doctor/core';
import type { Platform, StudioState } from '../contract';
import { accountLabel } from '../model';
import { StudioPill } from './Badges';
import { DesktopAppLink } from './web/DesktopAppLink';

interface Props {
  platform: Platform;
  root: string;
  accounts: AccountSummary[];
  userId: string | undefined;
  studio: StudioState | 'checking';
  busy: boolean;
  onChangeFolder: () => void;
  onChangeAccount: (id: string) => void;
}

export function Header({
  platform,
  root,
  accounts,
  userId,
  studio,
  busy,
  onChangeFolder,
  onChangeAccount,
}: Props) {
  const web = platform === 'web';
  return (
    <header className="header">
      <div className="brand">
        <img className="logo" src="./icon.png" alt="" width={36} height={36} />
        <div>
          <h1>Preset Doctor</h1>
          <p className="tagline">Brings back filament presets that Bambu Studio lost track of</p>
        </div>
        {web ? <DesktopAppLink /> : <StudioPill state={studio} />}
      </div>
      <div className="header-row">
        <div className="field grow">
          <span className="field-label">
            {web ? 'Your copy of the Bambu Studio folder' : 'Bambu Studio folder'}
          </span>
          <div className="folder">
            <code className="path" data-testid="root-path" title={root}>
              {root === '' && web ? 'No folder chosen yet' : root}
            </code>
            <button
              type="button"
              className="btn"
              onClick={onChangeFolder}
              disabled={busy}
              data-testid="change-folder"
            >
              {web && root === '' ? 'Choose folder…' : 'Change folder…'}
            </button>
          </div>
        </div>
        {accounts.length > 0 && (
          <label className="field">
            <span className="field-label">Account</span>
            <select
              value={userId ?? ''}
              onChange={(e) => onChangeAccount(e.target.value)}
              disabled={busy || accounts.length < 2}
              data-testid="account-picker"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountLabel(a.id, a.presetCount)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </header>
  );
}
