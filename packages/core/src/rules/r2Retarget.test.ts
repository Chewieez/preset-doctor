import { describe, expect, it } from 'vitest';
import type { Candidate, CompatDetail, UserPreset } from '../types.js';
import { findRetargetCandidates, suggestRetargetName } from './r2Retarget.js';
import type { SystemEntry, SystemIndex } from '../systemIndex.js';
import type { CompatInputs } from '../compat.js';

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

describe('suggestRetargetName', () => {
  it('replaces old printer tag in preset name with new printer tag', () => {
    expect(
      suggestRetargetName('Bambu PLA Basic @BBL X1C - 60C bed temp', 'X1C', 'Bambu Lab P1S'),
    ).toBe('Bambu PLA Basic @BBL P1S - 60C bed temp');
  });

  it('returns undefined if preset name has no printer tag', () => {
    expect(
      suggestRetargetName('Bambu PLA Basic - PA.025 AF 0%', 'X1C', 'Bambu Lab P1S'),
    ).toBeUndefined();
  });
});

describe('findRetargetCandidates', () => {
  it('finds matching system preset for installed P1S printer when parent was X1C', async () => {
    const mockSystem: Partial<SystemIndex> = {
      namesWithStem: (stem: string) => {
        if (stem.toLowerCase() === 'bambu pla basic') {
          return [
            'Bambu PLA Basic @BBL X1C',
            'Bambu PLA Basic @BBL X1C 0.4 nozzle',
            'Bambu PLA Basic @BBL P1S 0.4 nozzle',
            'Bambu PLA Basic @BBL A1M 0.4 nozzle',
          ];
        }
        return [];
      },
      parsed: (name: string) => ({
        stem: 'Bambu PLA Basic',
        vendorTag: 'BBL',
        printerCode: name.includes('P1S') ? 'P1S' : name.includes('X1C') ? 'X1C' : 'A1M',
        nozzle: '0.4',
      }),
      effectiveCompatiblePrinters: async (name: string) => {
        if (name === 'Bambu PLA Basic @BBL P1S 0.4 nozzle') {
          return ['Bambu Lab P1S 0.4 nozzle'];
        }
        if (name.includes('X1C')) {
          return ['Bambu Lab X1 Carbon 0.4 nozzle'];
        }
        return [];
      },
      get: (name: string) =>
        ({
          name,
          file: `${name}.json`,
          setting_id: name === 'Bambu PLA Basic @BBL P1S 0.4 nozzle' ? 'PFUS_P1S_04' : 'PFUS_X1C_04',
        }) as unknown as SystemEntry,
    };

    const preset: UserPreset = {
      type: 'filament',
      accountId: '12345678',
      path: 'user/12345678/filament/Bambu PLA Basic @BBL X1C - 60C bed temp.json',
      fileStem: 'Bambu PLA Basic @BBL X1C - 60C bed temp',
      isBase: false,
      raw: '{}',
      infoPath: 'user/12345678/filament/Bambu PLA Basic @BBL X1C - 60C bed temp.info',
    };

    const inputs: CompatInputs = {
      enabled: [
        {
          name: 'Bambu Lab P1S 0.4 nozzle',
          model: 'Bambu Lab P1S',
          nozzle: '0.4',
          vendor: 'BBL',
          isUser: false,
        },
      ],
      enabledModels: [{ vendor: 'BBL', model: 'Bambu Lab P1S', nozzles: ['0.4'] }],
      knownPrinters: new Map(),
      vendorCheck: true,
    };

    const candidates = await findRetargetCandidates(
      preset,
      'Bambu PLA Basic @BBL X1C',
      mockSystem as SystemIndex,
      inputs,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.name).toBe('Bambu PLA Basic @BBL P1S 0.4 nozzle');
    expect(candidates[0]?.confidence).toBe('high');
    expect(candidates[0]?.printerModel).toBe('Bambu Lab P1S');
    expect(candidates[0]?.settingId).toBe('PFUS_P1S_04');
    expect(candidates[0]?.preselected).toBe(true);
    expect(candidates[0]?.suggestedName).toBe('Bambu PLA Basic @BBL P1S - 60C bed temp');
  });
});

