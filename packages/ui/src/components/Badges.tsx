import type { Candidate, PresetStatus } from '@preset-doctor/core';
import type { StudioState } from '../contract';
import { CONFIDENCE_LABEL, STATUS_LABEL } from '../model';

export function StatusBadge({ status }: { status: PresetStatus }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function ConfidenceBadge({ confidence }: { confidence: Candidate['confidence'] }) {
  return <span className={`badge conf-${confidence}`}>{CONFIDENCE_LABEL[confidence]}</span>;
}

const STUDIO_TEXT: Record<StudioState | 'checking', string> = {
  closed: 'Bambu Studio is closed',
  running: 'Bambu Studio is open',
  unknown: "Can't tell if Bambu Studio is open",
  checking: 'Checking for Bambu Studio…',
};

export function StudioPill({ state }: { state: StudioState | 'checking' }) {
  return (
    <span className={`pill studio-${state}`} data-testid="studio-pill" role="status">
      <span className="dot" aria-hidden="true" />
      {STUDIO_TEXT[state]}
    </span>
  );
}
