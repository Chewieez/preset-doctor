import type { Finding, PresetSummary } from '@preset-doctor/core';
import type { PlannedChange } from '../contract';
import {
  CLOUD_SYNC_RULE,
  displayName,
  hasFix,
  orderFindings,
  type PresetFixes,
  type Selection,
} from '../model';
import { ConfidenceBadge, StatusBadge } from './Badges';
import { DiffView } from './DiffView';

export interface Preview {
  loading: boolean;
  changes: PlannedChange[] | null;
  error: string | null;
}

interface Props {
  preset: PresetSummary | null;
  findings: Finding[];
  fixes: PresetFixes;
  selection: Selection;
  preview: Preview;
  onPick: (path: string, candidate: string | null) => void;
  onToggle: (path: string, checked: boolean) => void;
}

export function DetailPanel({
  preset,
  findings,
  fixes,
  selection,
  preview,
  onPick,
  onToggle,
}: Props) {
  if (!preset) {
    return (
      <aside className="detail placeholder" aria-label="Details">
        <p>Click a preset to see what's wrong and how it would be repaired.</p>
      </aside>
    );
  }
  const path = preset.path;
  const pick = selection.picks[path];
  const checked = Boolean(selection.checked[path]);
  const [main, ...notes] = orderFindings(findings.filter((f) => f.ruleId !== CLOUD_SYNC_RULE));
  const fixable = hasFix(fixes);
  const radioName = `candidate-${path}`;

  return (
    <aside className="detail" aria-label="Details" data-testid="detail-panel">
      <div className="detail-head">
        <h2>{displayName(preset)}</h2>
        <StatusBadge status={preset.status} />
      </div>
      <code className="detail-path">{path}</code>
      {preset.inherits ? (
        <p className="muted">
          Based on: <strong>{preset.inherits}</strong>
        </p>
      ) : null}

      {!main && <p>This preset looks fine. Bambu Studio should show it normally.</p>}
      {main && (
        <section className="finding">
          <h3>{main.title}</h3>
          <p>{main.explanation}</p>
        </section>
      )}

      {fixes.candidates && (
        <fieldset className="candidates">
          <legend>Choose the new parent preset</legend>
          {fixes.candidates.map((c) => (
            <label
              key={c.name}
              className={`candidate ${pick === c.name && checked ? 'chosen' : ''}`}
            >
              <input
                type="radio"
                name={radioName}
                checked={pick === c.name && checked}
                onChange={() => onPick(path, c.name)}
              />
              <span className="candidate-body">
                <span className="candidate-name">
                  {c.name} <ConfidenceBadge confidence={c.confidence} />
                </span>
                <span className="candidate-reason">{c.reason}</span>
              </span>
            </label>
          ))}
          <label className={`candidate ${!checked ? 'chosen' : ''}`}>
            <input
              type="radio"
              name={radioName}
              checked={!checked}
              onChange={() => onPick(path, null)}
            />
            <span className="candidate-body">
              <span className="candidate-name">Leave this preset as it is</span>
            </span>
          </label>
        </fieldset>
      )}

      {fixes.rename !== undefined && !fixes.candidates && (
        <label className="rename-toggle">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onToggle(path, e.target.checked)}
          />
          Rename the preset to “{fixes.rename}” so it matches its file
        </label>
      )}

      {(preset.status === 'hidden' || preset.status === 'broken') && !fixable && (
        <p className="muted">
          Preset Doctor can't repair this one on its own. The explanation above says what to look
          at.
        </p>
      )}

      {fixable && (
        <section className="preview" aria-live="polite">
          <h3>{checked ? 'What will change' : 'Not selected for repair'}</h3>
          {checked && preview.loading && <p className="muted">Preparing preview…</p>}
          {checked && preview.error && <p className="error-text">{preview.error}</p>}
          {checked && preview.changes?.map((c) => <DiffView key={c.path} change={c} />)}
          {checked && preview.changes?.length === 0 && (
            <p className="muted">No file changes are needed.</p>
          )}
        </section>
      )}

      {notes.length > 0 && (
        <section className="notes">
          <h3>Also noticed</h3>
          {notes.map((f, i) => (
            <p key={i}>
              <strong>{f.title}.</strong> {f.explanation}
            </p>
          ))}
        </section>
      )}
    </aside>
  );
}
