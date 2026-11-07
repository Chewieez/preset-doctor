import { useState } from 'react';
import type { SlicerId } from '@preset-doctor/core';
import { COPY_FOLDER_EXAMPLE, RELEASES_URL } from '../../links';
import { SLICER_TEXT } from '../../model';
import { CopyText } from './CopyText';

interface Props {
  busy: boolean;
  onPick: () => void;
}

/**
 * Web only: how to make the copy this version works on, and how to put the result back. The
 * folder isn't picked yet, so the user says which slicer the steps are for.
 */
export function WebGuide({ busy, onPick }: Props) {
  const [slicer, setSlicer] = useState<SlicerId>('bambu');
  const s = SLICER_TEXT[slicer];
  return (
    <section className="guide" data-testid="web-guide">
      <div className="guide-head">
        <h2>Repair your presets in the browser</h2>
        <p className="muted">
          Browsers aren't allowed to open {s.name}'s own folder, so this version works on a copy of
          it. Everything happens on your computer; nothing is uploaded. The{' '}
          <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
            Windows app
          </a>{' '}
          skips the copying and repairs in place.
        </p>
        <div className="segmented" role="group" aria-label="Slicer" data-testid="guide-slicer">
          {(['bambu', 'orca'] as const).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={slicer === id}
              onClick={() => setSlicer(id)}
              data-testid={`guide-slicer-${id}`}
            >
              {SLICER_TEXT[id].name}
            </button>
          ))}
        </div>
      </div>
      <ol className="steps">
        <li>
          <strong>Close {s.name}, and keep it closed</strong> until you've copied the repaired files
          back (step 4).
        </li>
        <li>
          <strong>Copy three things into a new folder, right before repairing.</strong> An older
          copy doesn't have the changes you made in {s.short} since. In File Explorer, paste{' '}
          <CopyText text={s.folder} /> into the address bar. Copy the <code>system</code> and{' '}
          <code>user</code> folders and the <code>{s.conf}</code> file into a new folder, for
          example <CopyText text={COPY_FOLDER_EXAMPLE} />.{' '}
          {slicer === 'bambu'
            ? "Don't copy the whole BambuStudio folder: its logs can make it about 1.5 GB."
            : "Copy only those three: the OrcaSlicer folder also holds your sign-in and your printers' access codes, which Preset Doctor doesn't need."}
        </li>
        <li>
          <strong>Pick that folder here, then Scan and Fix.</strong> When the browser asks, allow it
          to view and edit files in that folder.
          <div className="step-action">
            <button
              type="button"
              className="btn primary"
              onClick={onPick}
              disabled={busy}
              data-testid="guide-pick"
            >
              Choose your copied folder…
            </button>
          </div>
        </li>
        <li>
          <strong>Copy the repaired files back.</strong> Preset Doctor lists exactly which files it
          changed. Copy each one from your copy to the same place inside{' '}
          <CopyText text={s.folder} /> and choose{' '}
          <strong>Replace the file in the destination</strong>. Don't copy the whole{' '}
          <code>user</code> folder back unless the copy is fresh: it would replace presets changed
          in {s.short} after the copy was made.
        </li>
      </ol>
    </section>
  );
}
