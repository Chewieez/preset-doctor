import { describe, expect, it } from 'vitest';
import type { Candidate, CompatDetail } from '../types.js';

describe('Retarget types', () => {
  it('supports printerModel and suggestedName on Candidate', () => {
    const candidate: Candidate = {
      name: 'Bambu PLA Basic @BBL P1S 0.4 nozzle',
      confidence: 'high',
      reason: 'Switch parent to your added Bambu Lab P1S (0.4 mm)',
      source: 'system',
      settingId: 'PFUS_001',
      preselected: true,
      printerModel: 'Bambu Lab P1S',
      suggestedName: 'Bambu PLA Basic @BBL P1S - 60C bed temp',
    };
    expect(candidate.printerModel).toBe('Bambu Lab P1S');
    expect(candidate.suggestedName).toBe('Bambu PLA Basic @BBL P1S - 60C bed temp');
  });

  it('supports retargetCandidates on CompatDetail', () => {
    const detail: CompatDetail = {
      state: 'printer-not-added',
      printers: ['Bambu Lab X1 Carbon 0.4 nozzle'],
      source: { kind: 'inherited', from: 'Bambu PLA Basic @BBL X1C' },
      retargetCandidates: [
        {
          name: 'Bambu PLA Basic @BBL P1S 0.4 nozzle',
          confidence: 'high',
          reason: 'Switch parent to your added Bambu Lab P1S (0.4 mm)',
          source: 'system',
          preselected: true,
          printerModel: 'Bambu Lab P1S',
        },
      ],
    };
    expect(detail.retargetCandidates).toHaveLength(1);
    expect(detail.retargetCandidates?.[0]?.printerModel).toBe('Bambu Lab P1S');
  });
});
