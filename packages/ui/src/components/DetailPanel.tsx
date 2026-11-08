import { useState } from 'react';
import type { Finding, PresetSummary } from '@preset-doctor/core';
import type { PlannedChange } from '../contract';
import {
  CLOUD_SYNC_RULE,
  compatLines,
  displayName,
  hasFix,
  nozzleOfferText,
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
  /** 'Bambu Studio' or 'OrcaSlicer', for the printer section. */
  slicer?: string;
  onPick: (path: string, candidate: string | null) => void;
  onToggle: (path: string, checked: boolean) => void;
  /** Opens "Offer presets on more nozzle sizes" with this preset ticked. */
  onMoreNozzles?: (path: string) => void;
}

export function DetailPanel({
  preset,
  findings,
  fixes,
  selection,
  preview,
  slicer = 'Bambu Studio',
  onPick,
  onToggle,
  onMoreNozzles,
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

      {!main && <p>This preset looks fine. {slicer} should show it normally.</p>}
      {main && (
        <section className="finding">
          <h3>{main.title}</h3>
          <p>{main.explanation}</p>
        </section>
      )}

      {fixes.candidates && (
        <fieldset className="candidates">
          <legend>
            {preset.status === 'unsupported'
              ? 'Retarget to an added printer'
              : 'Choose the new parent preset'}
          </legend>
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
                {c.printers && c.printers.length > 0 && <PrinterList printers={c.printers} />}
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

      {preset.compat && (
        <section className="printers-section" data-testid="printers-section">
          <h3>Printers</h3>
          <ul>
            {compatLines(preset.compat, slicer).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          {preset.status === 'unsupported' && !fixes.candidates && (
            <p className="muted">
              Preset Doctor doesn't change which printers this preset is for. The explanation above
              says what to do in {slicer}.
            </p>
          )}
          {preset.compat.moreNozzles && onMoreNozzles && (
            <p data-testid="more-nozzles">
              It isn't offered for every nozzle size you've added (
              {nozzleOfferText(preset.compat.moreNozzles)}).{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => onMoreNozzles(path)}
                data-testid="more-nozzles-button"
              >
                Offer it on more nozzle sizes…
              </button>
            </p>
          )}
        </section>
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

/** How many printers a candidate lists before the rest fold into "+N more". */
const PRINTERS_SHOWN = 3;

/** The printers a candidate is for (process presets): the new parent decides them. */
function PrinterList({ printers }: { printers: string[] }) {
  const [open, setOpen] = useState(false);
  const hidden = printers.length - PRINTERS_SHOWN;
  const shown = open || hidden <= 0 ? printers : printers.slice(0, PRINTERS_SHOWN);
  return (
    <span className="candidate-printers" data-testid="candidate-printers">
      For: {shown.join(', ')}
      {hidden > 0 && !open && (
        <>
          {' '}
          <button
            type="button"
            className="link-button"
            onClick={(e) => {
              // The list sits inside the candidate's label: don't pick the candidate.
              e.preventDefault();
              setOpen(true);
            }}
          >
            +{hidden} more
          </button>
        </>
      )}
    </span>
  );
}
