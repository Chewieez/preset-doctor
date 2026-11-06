import { describe, expect, it } from 'vitest';
import { loadSystemIndex } from '../systemIndex.js';
import { fakeStudio, type FakeSystemPreset } from '../testing/studio.js';
import {
  certainUnsuffixedNozzles,
  coversAll,
  nozzlesFor,
  ownCompat,
  possibleUnsuffixedNozzles,
  sortedNozzles,
  unsuffixedConvention,
} from './r1Nozzles.js';

const X2D = (n: string) => `Bambu Lab X2D ${n} nozzle`;
const X1C = (n: string) => `Bambu Lab X1 Carbon ${n} nozzle`;

const index = (system: FakeSystemPreset[]) => loadSystemIndex(fakeStudio(system, []));

describe('nozzle helpers', () => {
  it('nozzlesFor lists distinct sizes for one model, in list order', () => {
    expect(
      nozzlesFor([X2D('0.6'), X1C('0.4'), X2D('0.8'), X2D('0.60'), 'junk'], 'Bambu Lab X2D'),
    ).toEqual(['0.6', '0.8']);
    expect(nozzlesFor([], 'Bambu Lab X2D')).toEqual([]);
  });

  it('ownCompat accepts only a list of strings', () => {
    expect(ownCompat({ compatible_printers: [X2D('0.4')] })).toEqual([X2D('0.4')]);
    expect(ownCompat({ compatible_printers: [1] })).toBeUndefined();
    expect(ownCompat({ compatible_printers: 'x' })).toBeUndefined();
    expect(ownCompat(undefined)).toBeUndefined();
  });

  it('coversAll and sortedNozzles compare sizes by value', () => {
    expect(coversAll(['0.40', '0.6'], ['0.4'])).toBe(true);
    expect(coversAll(['0.4'], ['0.4', '0.6'])).toBe(false);
    expect(coversAll(['0.4'], [])).toBe(true);
    expect(sortedNozzles(['0.8', '0.4', '0.40', '0.2'])).toEqual(['0.2', '0.4', '0.8']);
  });
});

describe('unsuffixedConvention', () => {
  const SYSTEM: FakeSystemPreset[] = [
    { name: 'A @BBL X2D', compatible_printers: [X2D('0.6'), X2D('0.8')] },
    { name: 'B @BBL X2D', compatible_printers: [X2D('0.6')] },
    { name: 'B @BBL X2D 0.2 nozzle', compatible_printers: [X2D('0.2')] },
    // Not instantiable, unknown compatibility, or another printer: ignored.
    { name: 'C @BBL X2D', compatible_printers: [X2D('0.4')], instantiation: 'false' },
    { name: 'D @BBL X2D' },
    { name: 'A @BBL X1C', compatible_printers: [X1C('0.4')] },
  ];

  it('reads the sizes unsuffixed presets of one printer are for', async () => {
    const sys = await index(SYSTEM);
    const c = await unsuffixedConvention(
      { stem: 'Foo', vendorTag: 'BBL', printerCode: 'X2D' },
      'Bambu Lab X2D',
      sys,
    );
    expect(c).toEqual({ any: ['0.6', '0.8'], all: ['0.6'], printer: ['0.2', '0.6', '0.8'] });
    expect(possibleUnsuffixedNozzles(c)).toEqual(['0.2', '0.4', '0.6', '0.8']);
    expect(certainUnsuffixedNozzles(c)).toEqual(['0.6']);
  });

  it('matches the vendor tag and printer code case-insensitively, and caches per index', async () => {
    const sys = await index(SYSTEM);
    const parsed = { stem: 'Foo', vendorTag: 'bbl', printerCode: 'x2d' };
    const first = unsuffixedConvention(parsed, 'Bambu Lab X2D', sys);
    expect(unsuffixedConvention(parsed, 'Bambu Lab X2D', sys)).toBe(first);
    expect((await first)?.any).toEqual(['0.6', '0.8']);
  });

  it('uses the full model for wizard names', async () => {
    const sys = await index(SYSTEM);
    const c = await unsuffixedConvention(
      { stem: 'Foo', vendorTag: 'Bambu Lab', printerCode: 'X2D', model: 'Bambu Lab X2D' },
      'Bambu Lab X2D',
      sys,
    );
    expect(c?.any).toEqual(['0.6', '0.8']);
  });

  it('is null when the profile has nothing to learn from', async () => {
    const sys = await index(SYSTEM);
    const q1 = { stem: 'Foo', vendorTag: 'BBL', printerCode: 'Q1' };
    expect(await unsuffixedConvention(q1, 'Bambu Lab Q1', sys)).toBeNull();
    expect(await unsuffixedConvention({ stem: 'Foo' }, 'Bambu Lab X2D', sys)).toBeNull();
    expect(possibleUnsuffixedNozzles(null)).toBeNull();
    expect(certainUnsuffixedNozzles(null)).toEqual(['0.4']);
  });

  it('keeps 0.4 when every unsuffixed preset of the printer is for 0.4 alone', async () => {
    const sys = await index([
      { name: 'A @BBL X1C', compatible_printers: [X1C('0.4')] },
      { name: 'B @BBL X1C', compatible_printers: [X1C('0.40')] },
      { name: 'B @BBL X1C 0.6 nozzle', compatible_printers: [X1C('0.6')] },
    ]);
    const c = await unsuffixedConvention(
      { stem: 'Foo', vendorTag: 'BBL', printerCode: 'X1C' },
      'Bambu Lab X1 Carbon',
      sys,
    );
    expect(possibleUnsuffixedNozzles(c)).toEqual(['0.4']);
    expect(certainUnsuffixedNozzles(c)).toEqual(['0.4']);
  });
});
