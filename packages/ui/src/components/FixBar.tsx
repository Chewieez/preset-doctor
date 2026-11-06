import type { ReactNode } from 'react';
import type { StudioState } from '../contract';

interface Props {
  count: number;
  studio: StudioState | 'checking';
  busy: boolean;
  /** Web: the "I've closed Bambu Studio" checkbox, which stands in for the process check. */
  studioGate?: ReactNode;
  onFix: () => void;
}

export function FixBar({ count, studio, busy, studioGate, onFix }: Props) {
  const blocked =
    studio === 'closed'
      ? null
      : studioGate !== undefined
        ? 'Close Bambu Studio, then tick the box to repair presets.'
        : studio === 'running'
          ? 'Close Bambu Studio to repair presets. Preset Doctor notices within a few seconds.'
          : studio === 'unknown'
            ? "Repairs are off because Preset Doctor can't tell whether Bambu Studio is running."
            : 'Checking whether Bambu Studio is running…';
  return (
    <div className="fixbar" data-testid="fixbar">
      <div className="fixbar-text">
        <strong>
          {count === 0
            ? 'Nothing selected for repair'
            : `${count} preset${count === 1 ? '' : 's'} selected for repair`}
        </strong>
        <span className={blocked ? 'warn-text' : 'muted'} data-testid="fix-blocked-reason">
          {blocked ?? 'Your presets are backed up before anything is changed.'}
        </span>
      </div>
      <div className="fixbar-actions">
        {studioGate}
        <button
          type="button"
          className="btn primary"
          onClick={onFix}
          disabled={busy || count === 0 || blocked !== null}
          data-testid="fix-selected"
        >
          Fix selected…
        </button>
      </div>
    </div>
  );
}
