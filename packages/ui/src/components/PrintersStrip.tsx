import type { CompatContext, Finding } from '@preset-doctor/core';
import { printersText } from '../model';

interface Props {
  compat: CompatContext | undefined;
  /** 'Bambu Studio' or 'OrcaSlicer'. */
  slicer: string;
  /** The grouped "for another printer you've added" note, when there is one. */
  note: Finding | undefined;
  /** Lists the presets the note counts. */
  onShowNote: () => void;
}

/** Which printers are added in the slicer (R2/R3 compare against these), above the table. */
export function PrintersStrip({ compat, slicer, note, onShowNote }: Props) {
  if (!compat) return null;
  return (
    <div className="printers-strip" data-testid="printers-strip">
      <p className="printers-line" data-testid="printers-line">
        {printersText(compat, slicer)}
      </p>
      {note && (
        <div className="banner info" role="note" data-testid="other-printer-note">
          <span>
            <strong>{note.title}.</strong> {note.explanation}{' '}
            <button type="button" className="link-button" onClick={onShowNote}>
              Show them
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
