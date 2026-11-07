import type { AccountSummary } from '@preset-doctor/core';
import type { Platform, SlicerFolder, StudioState } from '../contract';
import { accountLabel, slicerOfRoot } from '../model';
import { useSlicer } from '../slicerContext';
import { StudioPill } from './Badges';
import { DesktopAppLink } from './web/DesktopAppLink';

interface Props {
  platform: Platform;
  root: string;
  /** Desktop: each slicer's default folder. A switch is shown when both exist. */
  slicers: SlicerFolder[];
  accounts: AccountSummary[];
  userId: string | undefined;
  studio: StudioState | 'checking';
  busy: boolean;
  onChangeFolder: () => void;
  onChangeAccount: (id: string) => void;
  /** Scans that slicer's default folder. */
  onSwitchSlicer: (root: string) => void;
}

export function Header({
  platform,
  root,
  slicers,
  accounts,
  userId,
  studio,
  busy,
  onChangeFolder,
  onChangeAccount,
  onSwitchSlicer,
}: Props) {
  const web = platform === 'web';
  const slicer = useSlicer();
  const installed = slicers.filter((s) => s.exists);
  // The slicer whose default folder is shown; none for a picked folder, whichever slicer it is.
  const shown = slicerOfRoot(slicers, root);
  return (
    <header className="header">
      <div className="brand">
        <img className="logo" src="./icon.png" alt="" width={36} height={36} />
        <div>
          <h1>Preset Doctor</h1>
          <p className="tagline">
            Brings back presets that Bambu Studio or OrcaSlicer lost track of
          </p>
        </div>
        {web ? <DesktopAppLink /> : <StudioPill state={studio} />}
      </div>
      {!web && installed.length === 2 && (
        <div className="segmented slicer-switch" role="group" aria-label="Slicer">
          {installed.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={shown === s.id}
              disabled={busy}
              onClick={() => {
                if (shown !== s.id) onSwitchSlicer(s.root);
              }}
              data-testid={`slicer-${s.id}`}
            >
              {s.displayName}
            </button>
          ))}
        </div>
      )}
      <div className="header-row">
        <div className="field grow">
          <span className="field-label">
            {web ? `Your copy of the ${slicer.name} folder` : `${slicer.name} folder`}
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
