import { useState } from 'react';
import type { FixChoice, PresetSummary } from '@preset-doctor/core';
import { displayName, nozzleOfferText } from '../model';
import { useSlicer } from '../slicerContext';
import { Dialog } from './Dialog';

interface Props {
  /** The filament presets with a nozzle offer (nozzleOffers). */
  offers: PresetSummary[];
  /** Paths ticked when the dialog opens. */
  initial: readonly string[];
  onReview: (choices: FixChoice[]) => void;
  onClose: () => void;
}

/**
 * Picks filament presets to offer for the other nozzle sizes of their printer. The change itself
 * goes through the same review, backup and write as a repair.
 */
export function NozzlesDialog({ offers, initial, onReview, onClose }: Props) {
  const slicer = useSlicer();
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(initial));
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const shown = offers.filter((p) => q === '' || displayName(p).toLowerCase().includes(q));
  const shownTicked = shown.filter((p) => checked.has(p.path)).length;
  const setMany = (paths: readonly string[], on: boolean): void =>
    setChecked((s) => {
      const next = new Set(s);
      for (const p of paths) {
        if (on) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  // In list order, so the review shows them in the same order.
  const choices = offers
    .filter((p) => checked.has(p.path))
    .map((p): FixChoice => ({ presetPath: p.path, allNozzles: true }));

  return (
    <Dialog
      title="Offer presets on more nozzle sizes"
      onClose={onClose}
      testId="nozzles-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={choices.length === 0}
            onClick={() => onReview(choices)}
            data-testid="nozzles-review"
          >
            Review {choices.length} change{choices.length === 1 ? '' : 's'}…
          </button>
        </>
      }
    >
      <p>
        {slicer.name} offers each filament preset only for the nozzle sizes it was made for. Tick
        the presets you want to use on the other nozzle sizes you've added too. Preset Doctor adds
        those sizes to the preset's printer list; your own settings stay as they are.
      </p>
      <ul className="nozzle-notes">
        <li>
          Settings you didn't change yourself still come from the preset it is based on, which was
          made for the original nozzle size. For most filaments those are the same on every size;
          check the max volumetric speed when you print with a much bigger or smaller nozzle.
        </li>
        <li>
          If you already made a copy of a preset for another nozzle size, both will show there after
          this. Delete the one you don't need in {slicer.name}.
        </li>
      </ul>
      <div className="nozzle-tools">
        <input
          type="search"
          className="search"
          placeholder="Find a preset…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Find a preset by name"
        />
        <button
          type="button"
          className="btn small"
          disabled={shown.length === 0 || shownTicked === shown.length}
          onClick={() =>
            setMany(
              shown.map((p) => p.path),
              true,
            )
          }
          data-testid="nozzles-select-all"
        >
          Select all
        </button>
        <button
          type="button"
          className="btn small"
          disabled={shownTicked === 0}
          onClick={() =>
            setMany(
              shown.map((p) => p.path),
              false,
            )
          }
          data-testid="nozzles-select-none"
        >
          Select none
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="muted">No presets match.</p>
      ) : (
        <ul className="nozzle-list" data-testid="nozzle-list">
          {shown.map((p) => (
            <li key={p.path}>
              <label className="option">
                <input
                  type="checkbox"
                  checked={checked.has(p.path)}
                  onChange={(e) => setMany([p.path], e.target.checked)}
                  data-testid="nozzle-row"
                />
                <span>
                  <strong>{displayName(p)}</strong>
                  <span className="muted"> · {nozzleOfferText(p.compat!.moreNozzles!)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
