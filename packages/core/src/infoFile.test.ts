import { describe, expect, it } from 'vitest';
import {
  getInfoValue,
  infoEntries,
  parseInfoFile,
  serializeInfoFile,
  setInfoValue,
} from './infoFile.js';
import { fixtureFiles, readFixture } from './testing/fixtures.js';

const infoFixtures = fixtureFiles('.info');

const STUDIO_SAMPLE =
  'sync_info = \r\nuser_id = 1000000001\r\nsetting_id = PFUS0000000000aa\r\nbase_id = GFSG99_15\r\nupdated_time = 1782278409\r\n';

describe('infoFile round-trip over every fixture', () => {
  it('found the fixtures', () => {
    expect(infoFixtures.length).toBeGreaterThan(30);
  });

  it.each(infoFixtures)('%s', (rel) => {
    const text = readFixture(rel);
    const info = parseInfoFile(text);
    expect(serializeInfoFile(info)).toBe(text);
    expect(Object.keys(infoEntries(info))).toEqual([
      'sync_info',
      'user_id',
      'setting_id',
      'base_id',
      'updated_time',
    ]);
  });

  it('fixtures carry only anonymized account ids', () => {
    for (const rel of infoFixtures) {
      const userId = getInfoValue(parseInfoFile(readFixture(rel)), 'user_id');
      expect(['1000000001', '1000000002'], rel).toContain(userId);
      expect(rel).toContain(`/user/${userId}/`);
    }
  });
});

describe('parseInfoFile', () => {
  it('reads the Studio layout, including the empty sync_info with its trailing space', () => {
    const info = parseInfoFile(STUDIO_SAMPLE);
    expect(infoEntries(info)).toEqual({
      sync_info: '',
      user_id: '1000000001',
      setting_id: 'PFUS0000000000aa',
      base_id: 'GFSG99_15',
      updated_time: '1782278409',
    });
    expect(info.lines[0]).toMatchObject({ prefix: 'sync_info = ', value: '', eol: '\r\n' });
  });

  it('preserves unknown lines, odd spacing, LF and a missing final newline', () => {
    const text = '# comment\nweird line\n\nkey=val  \n  spaced   =   v w\nlast = x';
    const info = parseInfoFile(text);
    expect(serializeInfoFile(info)).toBe(text);
    expect(getInfoValue(info, 'key')).toBe('val');
    expect(getInfoValue(info, 'spaced')).toBe('  v w');
    expect(getInfoValue(info, 'last')).toBe('x');
    expect(getInfoValue(info, 'weird line')).toBeUndefined();
  });

  it('handles an empty file', () => {
    expect(serializeInfoFile(parseInfoFile(''))).toBe('');
  });
});

describe('setInfoValue', () => {
  it('changes only the value of one line', () => {
    const info = setInfoValue(parseInfoFile(STUDIO_SAMPLE), 'base_id', 'GFSG99_16');
    expect(serializeInfoFile(info)).toBe(STUDIO_SAMPLE.replace('GFSG99_15', 'GFSG99_16'));
  });

  it('fills an empty value without doubling the space', () => {
    const info = setInfoValue(parseInfoFile(STUDIO_SAMPLE), 'sync_info', 'x');
    expect(serializeInfoFile(info).startsWith('sync_info = x\r\n')).toBe(true);
  });

  it('does not mutate the input', () => {
    const original = parseInfoFile(STUDIO_SAMPLE);
    setInfoValue(original, 'base_id', 'X');
    setInfoValue(original, 'new_key', 'Y');
    expect(serializeInfoFile(original)).toBe(STUDIO_SAMPLE);
  });

  it('appends a missing key using the file line ending', () => {
    const info = setInfoValue(parseInfoFile(STUDIO_SAMPLE), 'extra', 'v');
    expect(serializeInfoFile(info)).toBe(`${STUDIO_SAMPLE}extra = v\r\n`);
    const noNl = setInfoValue(parseInfoFile('a = 1\nb = 2'), 'c', '3');
    expect(serializeInfoFile(noNl)).toBe('a = 1\nb = 2\nc = 3\n');
  });
});
