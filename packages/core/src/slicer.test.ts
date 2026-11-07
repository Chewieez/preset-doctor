import { describe, expect, it } from 'vitest';
import type { DirEntry } from './fs.js';
import { memFs } from './memFs.js';
import { BAMBU, detectSlicer, SLICERS } from './slicer.js';
import { PRESET_TYPES } from './types.js';
import { TERMS } from './terms.js';

const file = (name: string): DirEntry => ({ name, kind: 'file' });
const dir = (name: string): DirEntry => ({ name, kind: 'dir' });

describe('Bambu Studio profile', () => {
  it('loads BBL first, then vendors that have a folder', () => {
    const plan = BAMBU.vendorOrder([
      file('Creality.json'),
      dir('Creality'),
      file('Prusa.json'),
      file('BBL.json'),
      dir('BBL'),
      file('notes.txt'),
    ]);
    expect(plan).toEqual({ json: ['BBL', 'Creality'], opc: [], required: 'BBL' });
    expect(BAMBU.vendorOrder([]).json).toEqual(['BBL']);
  });

  it('comes first, and claims a folder with BambuStudio.conf or only BBL.json', async () => {
    expect(SLICERS[0]).toBe(BAMBU);
    expect(await detectSlicer(memFs({ 'BambuStudio.conf': '{}' }))).toMatchObject({
      ok: true,
      profile: BAMBU,
    });
    expect(await detectSlicer(memFs({ 'system/BBL.json': '{}' }))).toMatchObject({
      ok: true,
      profile: BAMBU,
    });
    expect(await detectSlicer(memFs({}))).toMatchObject({ ok: false, reason: 'neither' });
  });

  it('keeps the R5 title', () => {
    expect(BAMBU.cloudSyncText({ found: true }).title).toBe('Cloud preset sync is on');
  });
});

describe('preset type terms', () => {
  it('has wording and a settings id key for every type', () => {
    for (const type of PRESET_TYPES) expect(TERMS[type].noun).toMatch(/preset$/);
    expect(TERMS.filament.settingsIdKey).toEqual({ key: 'filament_settings_id', shape: 'array0' });
    expect(TERMS.process.settingsIdKey).toEqual({ key: 'print_settings_id', shape: 'string' });
    expect(TERMS.machine.settingsIdKey).toEqual({ key: 'printer_settings_id', shape: 'string' });
    expect(TERMS.machine.list).toBe('printer list');
  });
});
