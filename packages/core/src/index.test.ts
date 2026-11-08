import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as core from './index.js';
import * as node from './node/index.js';

describe('public API', () => {
  it('exports a version', () => {
    expect(core.VERSION).toBe('0.2.0');
  });

  it('keeps every workspace on the same version as VERSION', () => {
    for (const pkg of [
      '../../../package.json',
      '../package.json',
      '../../ui/package.json',
      '../../../apps/desktop/package.json',
      '../../../apps/web/package.json',
    ]) {
      const json = JSON.parse(readFileSync(new URL(pkg, import.meta.url), 'utf8')) as {
        version?: string;
      };
      expect(json.version, pkg).toBe(core.VERSION);
    }
  });

  it('exposes browser-safe helpers from the main entry and adapters from ./node', () => {
    for (const fn of [
      'memFs',
      'parseJsonFile',
      'serializeJsonFile',
      'setJsonStringField',
      'setJsonArrayStringItem',
      'parseInfoFile',
      'serializeInfoFile',
      'setInfoValue',
      'joinPath',
      'normalizePath',
    ] as const) {
      expect(typeof core[fn], fn).toBe('function');
    }
    expect('nodeFs' in core).toBe(false);
    expect(typeof node.nodeFs).toBe('function');
  });

  it('joinPath / fileStem / dirname behave on preset paths', () => {
    expect(core.joinPath('user', '', '1/filament', 'a.json')).toBe('user/1/filament/a.json');
    expect(core.fileStem('user/1/filament/Foo 0.4.json')).toBe('Foo 0.4');
    expect(core.fileStem('.gitkeep')).toBe('.gitkeep');
    expect(core.dirname('a.json')).toBe('');
    expect(core.basename('a/b/c.info')).toBe('c.info');
    expect(() => core.normalizePath('C:/x')).toThrow(/relative/);
  });
});
