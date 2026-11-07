import type { CompatContext, Finding } from '@preset-doctor/core';
import { printersText } from '../model';

/** A grouped note under the printers line, with a link that lists the presets it counts. */
export interface StripNote {
  finding: Finding;
  /** Lists the presets the note counts. */
  onShow: () => void;
  testId: string;
}

interface Props {
  compat: CompatContext | undefined;
  /** 'Bambu Studio' or 'OrcaSlicer'. */
  slicer: string;
  /**
   * The grouped notes that are there: "for another printer you've added" and "copies of presets
   * you already use on your printers".
   */
  notes: readonly StripNote[];
}

/** Which printers are added in the slicer (R2/R3 compare against these), above the table. */
export function PrintersStrip({ compat, slicer, notes }: Props) {
  if (!compat) return null;
  return (
    <div className="printers-strip" data-testid="printers-strip">
      <p className="printers-line" data-testid="printers-line">
        {printersText(compat, slicer)}
      </p>
      {notes.map((n) => (
        <div key={n.testId} className="banner info" role="note" data-testid={n.testId}>
          <span>
            <strong>{n.finding.title}.</strong> {n.finding.explanation}{' '}
            <button type="button" className="link-button" onClick={n.onShow}>
              Show them
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
