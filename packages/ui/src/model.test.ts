import type { Finding, PresetSummary, ScanResult } from '@preset-doctor/core';
import { describe, expect, it } from 'vitest';
import {
  choiceFor,
  findingsByPath,
  fixesFor,
  initialSelection,
  isProblem,
  mergePaths,
  orderFindings,
  selectedChoices,
  visiblePresets,
  windowsPath,
} from './model';

const preset = (path: string, status: PresetSummary['status'], name?: string): PresetSummary => ({
  accountId: '1000000001',
  path,
  ...(name ? { name } : {}),
  isBase: false,
  status,
  reason: '',
  ruleIds: [],
});

const orphan: Finding = {
  ruleId: 'R1_ORPHANED_PARENT',
  severity: 'error',
  presetPath: 'a.json',
  status: 'hidden',
  title: 'Parent preset is missing',
  explanation: '',
  proposedFix: {
    kind: 'setInherits',
    candidates: [
      { name: 'High', confidence: 'high', reason: '', preselected: true },
      { name: 'Low', confidence: 'low', reason: '', preselected: false },
    ],
  },
};
const lowOnly: Finding = {
  ...orphan,
  presetPath: 'b.json',
  proposedFix: {
    kind: 'setInherits',
    candidates: [{ name: 'Low', confidence: 'low', reason: '', preselected: false }],
  },
};
const rename: Finding = {
  ruleId: 'R4_MALFORMED',
  severity: 'warning',
  presetPath: 'c.json',
  status: 'info',
  title: 'Name mismatch',
  explanation: '',
  proposedFix: { kind: 'renamePreset', newName: 'c' },
};
const note: Finding = { ...rename, presetPath: 'd.json', severity: 'info', title: 'No sync file' };
delete (note as { proposedFix?: unknown }).proposedFix;

const scan: ScanResult = {
  root: 'X',
  userId: '1000000001',
  accounts: [{ id: '1000000001', presetCount: 5 }],
  presets: [
    preset('e.json', 'ok', 'Echo'),
    preset('d.json', 'info', 'delta'),
    preset('c.json', 'info', 'c.json'),
    preset('b.json', 'hidden', 'Bravo'),
    preset('a.json', 'hidden', 'Alpha'),
  ],
  findings: [orphan, lowOnly, rename, note],
  warnings: [],
  systemVersion: '1',
  systemIndexRead: true,
};
const byPath = findingsByPath(scan);

describe('renderer model', () => {
  it('needs-attention filter keeps hidden, broken and fixable rows, sorted', () => {
    expect(visiblePresets(scan, byPath, 'problems', '').map((p) => p.path)).toEqual([
      'a.json',
      'b.json',
      'c.json',
    ]);
    expect(visiblePresets(scan, byPath, 'all', '')).toHaveLength(5);
    expect(visiblePresets(scan, byPath, 'all', 'DEL').map((p) => p.path)).toEqual(['d.json']);
    expect(isProblem(scan.presets[1]!, byPath)).toBe(false);
  });

  it('starts from the default picks and only sends complete choices', () => {
    const sel = initialSelection([
      { presetPath: 'a.json', candidateName: 'High' },
      { presetPath: 'c.json', rename: true },
    ]);
    expect(selectedChoices(scan, byPath, sel)).toEqual([
      { presetPath: 'c.json', rename: true },
      { presetPath: 'a.json', candidateName: 'High' },
    ]);
    // Ticking a row with no pick yet sends nothing for it.
    sel.checked['b.json'] = true;
    expect(selectedChoices(scan, byPath, sel)).toHaveLength(2);
    sel.picks['b.json'] = 'Low';
    expect(selectedChoices(scan, byPath, sel)).toContainEqual({
      presetPath: 'b.json',
      candidateName: 'Low',
    });
  });

  it('ignores a pick that is not one of the candidates', () => {
    expect(choiceFor('a.json', fixesFor([orphan]), { 'a.json': 'Nope' })).toBeNull();
  });

  it('lists fixable findings first', () => {
    expect(orderFindings([note, rename]).map((f) => f.title)).toEqual([
      'Name mismatch',
      'No sync file',
    ]);
  });
});

describe('changed-file lists (web copy-back)', () => {
  it('shows paths the Windows way', () => {
    expect(windowsPath('user/1000000001/filament/A b.json')).toBe(
      'user\\1000000001\\filament\\A b.json',
    );
  });

  it('merges without duplicates, sorted', () => {
    expect(mergePaths(['user/b.json', 'user/a.json'], ['user/a.json', 'user/a.info'])).toEqual([
      'user/a.info',
      'user/a.json',
      'user/b.json',
    ]);
  });
});
