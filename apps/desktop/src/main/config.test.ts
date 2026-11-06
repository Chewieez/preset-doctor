import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';

const defaults = {
  studioRoot: 'C:\\Roaming\\BambuStudio',
  backupsDir: 'C:\\Roaming\\PresetDoctor\\backups',
};

describe('readConfig', () => {
  it('uses the detected folders by default', () => {
    expect(readConfig({}, defaults)).toEqual({
      root: defaults.studioRoot,
      backupsDir: defaults.backupsDir,
      testMode: false,
      fakeStudioRunning: null,
    });
  });

  it('takes folder overrides from the environment', () => {
    const c = readConfig(
      { PRESET_DOCTOR_ROOT: 'D:\\copy', PRESET_DOCTOR_BACKUPS: 'D:\\b' },
      defaults,
    );
    expect(c).toMatchObject({ root: 'D:\\copy', backupsDir: 'D:\\b', testMode: true });
  });

  it('honors the fake Studio flag only with a root override', () => {
    expect(readConfig({ PRESET_DOCTOR_FAKE_STUDIO_RUNNING: '0' }, defaults).fakeStudioRunning).toBe(
      null,
    );
    const env = { PRESET_DOCTOR_ROOT: 'D:\\copy' };
    expect(
      readConfig({ ...env, PRESET_DOCTOR_FAKE_STUDIO_RUNNING: '0' }, defaults).fakeStudioRunning,
    ).toBe(false);
    expect(
      readConfig({ ...env, PRESET_DOCTOR_FAKE_STUDIO_RUNNING: '1' }, defaults).fakeStudioRunning,
    ).toBe(true);
    expect(
      readConfig({ ...env, PRESET_DOCTOR_FAKE_STUDIO_RUNNING: 'yes' }, defaults).fakeStudioRunning,
    ).toBe(null);
  });

  it('never fakes the Studio check when the override is the real Studio folder', () => {
    for (const real of [defaults.studioRoot, 'c:\\roaming\\bambustudio\\']) {
      const c = readConfig(
        { PRESET_DOCTOR_ROOT: real, PRESET_DOCTOR_FAKE_STUDIO_RUNNING: '0' },
        defaults,
        'win32',
      );
      expect(c).toMatchObject({ testMode: true, fakeStudioRunning: null });
    }
  });

  it('ignores blank overrides', () => {
    expect(readConfig({ PRESET_DOCTOR_ROOT: '  ' }, defaults).testMode).toBe(false);
  });
});
