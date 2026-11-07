import type { PlanPayload, StudioState } from '../contract';
import { presetFilesIn } from '../model';
import { useSlicer } from '../slicerContext';
import { Dialog } from './Dialog';
import { DiffView } from './DiffView';

interface Props {
  plan: PlanPayload | null;
  loading: boolean;
  error: string | null;
  updateBaseId: boolean;
  studio: StudioState | 'checking';
  applying: boolean;
  onToggleBaseId: (on: boolean) => void;
  onApply: () => void;
  onClose: () => void;
}

export function ReviewDialog(props: Props) {
  const { plan } = props;
  const slicer = useSlicer();
  const presets = plan ? presetFilesIn(plan.changes.map((c) => c.path)) : 0;
  const canApply =
    plan !== null && plan.changes.length > 0 && props.studio === 'closed' && !props.applying;
  return (
    <Dialog
      title="Review the repairs"
      onClose={props.applying ? () => undefined : props.onClose}
      testId="review-dialog"
      footer={
        <>
          {props.studio !== 'closed' && (
            <span className="warn-text">Close {slicer.name} before repairing.</span>
          )}
          <button type="button" className="btn" onClick={props.onClose} disabled={props.applying}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={props.onApply}
            disabled={!canApply}
            data-testid="confirm-apply"
          >
            {props.applying
              ? 'Repairing…'
              : `Back up and repair ${presets} preset${presets === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <p>
        Preset Doctor first saves a backup of your whole <code>user</code> folder, then makes
        exactly these changes. Nothing else is touched.
      </p>
      <label className="option">
        <input
          type="checkbox"
          checked={props.updateBaseId}
          onChange={(e) => props.onToggleBaseId(e.target.checked)}
          disabled={props.applying}
        />
        <span>
          Also update the preset's sync file (<code>.info</code>) to point at the new parent
          <span className="muted"> (recommended; {slicer.name} does the same when you save)</span>
        </span>
      </label>
      {props.loading && <p className="muted">Preparing changes…</p>}
      {props.error && <p className="error-text">{props.error}</p>}
      {plan && (
        <div className="review-list">
          <p className="muted">
            {plan.changes.length} file change{plan.changes.length === 1 ? '' : 's'}:
          </p>
          {plan.changes.map((c) => (
            <DiffView key={c.path} change={c} />
          ))}
        </div>
      )}
    </Dialog>
  );
}
