import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JSON_FORMAT,
  JsonFileError,
  detectJsonFormat,
  parseJsonFile,
  serializeJsonFile,
  setJsonArrayStringItem,
  setJsonStringField,
  topLevelKeys,
  tryParseJsonFile,
} from './jsonFile.js';
import { fixtureFiles, readFixture } from './testing/fixtures.js';

const jsonFixtures = fixtureFiles('.json');
const isUserPreset = (rel: string): boolean => /\/user\/[^/]+\/filament\//.test(rel);
// Deliberately invalid fixture (broken-r4).
const INVALID = new Set(['broken-r4/user/1000000001/filament/Truncated Preset.json']);

function changedLines(a: string, b: string): number {
  const la = a.split('\n');
  const lb = b.split('\n');
  expect(lb.length).toBe(la.length);
  return la.filter((l, i) => l !== lb[i]).length;
}

describe('jsonFile round-trip over every fixture', () => {
  it('found the fixtures', () => {
    expect(jsonFixtures.length).toBeGreaterThan(400);
  });

  it.each(jsonFixtures.filter((f) => !INVALID.has(f)))('%s', (rel) => {
    const text = readFixture(rel);
    const { value, format } = parseJsonFile(text);
    if (format.canonical) {
      expect(serializeJsonFile(value, format)).toBe(text);
    } else {
      // Hand-edited system templates only; we never rewrite these wholesale.
      expect(rel).toMatch(/\/system\/BBL\/(filament|process|machine)\/fdm_\1_[^/]+\.json$/);
    }
    // The minimal-edit path is byte-identical for every file, canonical or not.
    const keys = topLevelKeys(text);
    const firstString = keys.find((k) => typeof (value as Record<string, unknown>)[k] === 'string');
    if (firstString !== undefined) {
      const current = (value as Record<string, string>)[firstString]!;
      expect(setJsonStringField(text, firstString, current)).toBe(text);
    }
    expect(keys).toEqual(Object.keys(value as object));
  });

  it('every user preset Studio wrote is canonical', () => {
    const user = jsonFixtures.filter((f) => isUserPreset(f) && !INVALID.has(f));
    expect(user.length).toBeGreaterThan(50);
    for (const rel of user)
      expect(parseJsonFile(readFixture(rel)).format.canonical, rel).toBe(true);
  });

  it('covers both LF-without-newline and CRLF-with-newline files', () => {
    const formats = new Set(
      jsonFixtures
        .filter((f) => !INVALID.has(f))
        .map((f) => {
          const fmt = parseJsonFile(readFixture(f)).format;
          return `${fmt.eol === '\r\n' ? 'CRLF' : 'LF'}:${fmt.trailingNewline}`;
        }),
    );
    expect(formats).toContain('LF:false');
    expect(formats).toContain('CRLF:true');
  });

  it('reports the truncated fixture as a parse error', () => {
    for (const rel of INVALID) {
      const res = tryParseJsonFile(readFixture(rel));
      expect(res.ok).toBe(false);
      expect(() => parseJsonFile(readFixture(rel))).toThrow(JsonFileError);
    }
  });
});

describe('detectJsonFormat / serializeJsonFile', () => {
  it('detects CRLF, BOM, trailing newline and tab indent', () => {
    expect(detectJsonFormat('﻿{\r\n\t"a": 1\r\n}\r\n')).toEqual({
      indent: '\t',
      eol: '\r\n',
      trailingNewline: true,
      bom: true,
    });
  });

  it('defaults to 4 spaces for single-line or empty objects', () => {
    expect(detectJsonFormat('{}').indent).toBe('    ');
    expect(parseJsonFile('{}').format.canonical).toBe(true);
  });

  it('round-trips a BOM file', () => {
    const text = '﻿{\n    "name": "x"\n}';
    const { value, format } = parseJsonFile(text);
    expect(format.bom).toBe(true);
    expect(serializeJsonFile(value, format)).toBe(text);
  });

  it('flags non-canonical layout', () => {
    expect(parseJsonFile('{\n    "a":[\n        "1"\n    ]\n}').format.canonical).toBe(false);
  });

  it('keeps newlines inside strings escaped when switching to CRLF', () => {
    const out = serializeJsonFile({ g: 'a\nb' }, { ...DEFAULT_JSON_FORMAT, eol: '\r\n' });
    expect(out).toBe('{\r\n    "g": "a\\nb"\r\n}');
  });
});

describe('setJsonStringField', () => {
  const userPresets = jsonFixtures.filter((f) => isUserPreset(f) && !INVALID.has(f));

  it.each(userPresets.filter((f) => !f.includes('/base/')).slice(0, 40))(
    'changes exactly one line: %s',
    (rel) => {
      const text = readFixture(rel);
      const before = parseJsonFile(text).value as Record<string, unknown>;
      if (typeof before.inherits !== 'string') return;
      const after = setJsonStringField(text, 'inherits', 'Generic PETG @BBL X2D');
      expect(changedLines(text, after)).toBe(1);
      expect(JSON.parse(after)).toEqual({ ...before, inherits: 'Generic PETG @BBL X2D' });
      expect(topLevelKeys(after)).toEqual(Object.keys(before));
      const { format } = parseJsonFile(after);
      expect(format.canonical).toBe(true);
    },
  );

  it('works on a hand-edited, non-canonical system file', () => {
    const text = readFixture('healthy/system/BBL/filament/fdm_filament_common.json');
    expect(parseJsonFile(text).format.canonical).toBe(false);
    const after = setJsonStringField(text, 'name', 'renamed');
    expect(changedLines(text, after)).toBe(1);
    expect((JSON.parse(after) as { name: string }).name).toBe('renamed');
  });

  it('only matches top-level keys', () => {
    const text = '{\n    "inner": {\n        "name": "keep"\n    },\n    "name": "old"\n}';
    expect(JSON.parse(setJsonStringField(text, 'name', 'new'))).toEqual({
      inner: { name: 'keep' },
      name: 'new',
    });
    expect(() =>
      setJsonStringField('{\n    "inner": {\n        "x": "y"\n    }\n}', 'x', 'z'),
    ).toThrow(/not found/);
  });

  it('escapes the new value like JSON.stringify and handles escaped old values', () => {
    const text = '{\n    "name": "a \\"quoted\\" \\\\ name"\n}';
    const after = setJsonStringField(text, 'name', 'b "q" \\ é');
    expect((JSON.parse(after) as { name: string }).name).toBe('b "q" \\ é');
    expect(after).toBe('{\n    "name": "b \\"q\\" \\\\ é"\n}');
  });

  it('keeps the BOM', () => {
    const after = setJsonStringField('﻿{\n    "name": "a"\n}', 'name', 'b');
    expect(after).toBe('﻿{\n    "name": "b"\n}');
  });

  it('refuses missing, duplicated and non-string keys', () => {
    expect(() => setJsonStringField('{\n    "a": "1"\n}', 'b', 'x')).toThrow(/not found/);
    expect(() => setJsonStringField('{"a": "1", "a": "2"}', 'a', 'x')).toThrow(/more than once/);
    expect(() => setJsonStringField('{"a": ["1"]}', 'a', 'x')).toThrow(/not a string/);
    expect(() => setJsonStringField('["a"]', 'a', 'x')).toThrow(/not an object/);
  });
});

describe('setJsonArrayStringItem', () => {
  it('rewrites filament_settings_id[0] in one line (CRLF fixture)', () => {
    const rel = 'broken-r4/user/1000000001/filament/test.json';
    const text = readFixture(rel);
    const after = setJsonArrayStringItem(text, 'filament_settings_id', 0, 'test');
    expect(changedLines(text, after)).toBe(1);
    const v = JSON.parse(after) as { filament_settings_id: string[]; name: string };
    expect(v.filament_settings_id).toEqual(['test']);
    expect(v.name).toBe('test.json');
  });

  it('addresses later items and skips nested arrays', () => {
    const text = '{"a": [["x", "y"], "b", "c"]}';
    expect(JSON.parse(setJsonArrayStringItem(text, 'a', 2, 'Z'))).toEqual({
      a: [['x', 'y'], 'b', 'Z'],
    });
    expect(() => setJsonArrayStringItem(text, 'a', 0, 'Z')).toThrow(/not a string/);
    expect(() => setJsonArrayStringItem(text, 'a', 3, 'Z')).toThrow(/no item/);
    expect(() => setJsonArrayStringItem('{"a": "s"}', 'a', 0, 'Z')).toThrow(/not an array/);
  });
});
