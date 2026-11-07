import type { Candidate, PresetStatus } from '@preset-doctor/core';
import type { StudioState } from '../contract';
import { CONFIDENCE_LABEL, STATUS_LABEL } from '../model';
import { useSlicer } from '../slicerContext';

export function StatusBadge({ status }: { status: PresetStatus }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function ConfidenceBadge({ confidence }: { confidence: Candidate['confidence'] }) {
  return <span className={`badge conf-${confidence}`}>{CONFIDENCE_LABEL[confidence]}</span>;
}

const STUDIO_TEXT: Record<StudioState | 'checking', (name: string) => string> = {
  closed: (name) => `${name} is closed`,
  running: (name) => `${name} is open`,
  unknown: (name) => `Can't tell if ${name} is open`,
  checking: (name) => `Checking for ${name}…`,
};

/** Whether the slicer of the folder on screen is running (desktop). */
export function StudioPill({ state }: { state: StudioState | 'checking' }) {
  const { name } = useSlicer();
  return (
    <span className={`pill studio-${state}`} data-testid="studio-pill" role="status">
      <span className="dot" aria-hidden="true" />
      {STUDIO_TEXT[state](name)}
    </span>
  );
}
