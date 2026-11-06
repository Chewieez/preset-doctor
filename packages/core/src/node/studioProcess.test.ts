import { describe, expect, it } from 'vitest';
import {
  defaultPaths,
  isStudioProcessName,
  isStudioRunning,
  parsePsOutput,
  parseTasklistCsv,
  processListProgram,
  type CommandRunner,
} from './studioProcess.js';

const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"explorer.exe","4321","Console","1","120,000 K"',
  '"bambu-studio.exe","9876","Console","1","900,000 K"',
  '',
].join('\r\n');

function fakeRunner(stdout: string, calls: [string, string[]][] = []): CommandRunner {
  return async (file, args) => {
    calls.push([file, args]);
    return stdout;
  };
}

describe('isStudioProcessName', () => {
  it('matches both names, any case, with or without .exe', () => {
    for (const n of [
      'bambu-studio.exe',
      'BAMBU-STUDIO.EXE',
      'BambuStudio.exe',
      'bambustudio',
      'BambuStudio',
    ])
      expect(isStudioProcessName(n)).toBe(true);
    for (const n of ['bambu-studio-helper.exe', 'OrcaSlicer.exe', 'studio.exe', ''])
      expect(isStudioProcessName(n)).toBe(false);
  });
});

describe('parseTasklistCsv', () => {
  it('takes the first quoted field of each line', () => {
    expect(parseTasklistCsv(TASKLIST)).toEqual([
      'System Idle Process',
      'explorer.exe',
      'bambu-studio.exe',
    ]);
  });

  it('ignores the "no tasks" message', () => {
    expect(
      parseTasklistCsv('INFO: No tasks are running which match the specified criteria.\r\n'),
    ).toEqual([]);
  });
});

describe('parsePsOutput', () => {
  it('strips folders from macOS full paths', () => {
    expect(
      parsePsOutput(
        '/sbin/launchd\n/Applications/BambuStudio.app/Contents/MacOS/BambuStudio\n  bash\n',
      ),
    ).toEqual(['launchd', 'BambuStudio', 'bash']);
  });
});

describe('isStudioRunning', () => {
  it('runs tasklist from System32 by full path on Windows, never from the current folder', async () => {
    const calls: [string, string[]][] = [];
    const env = { SystemRoot: 'D:\\Win' };
    expect(
      await isStudioRunning({ platform: 'win32', env, run: fakeRunner(TASKLIST, calls) }),
    ).toBe(true);
    expect(calls).toEqual([['D:\\Win\\System32\\tasklist.exe', ['/FO', 'CSV', '/NH']]]);
    expect(processListProgram('win32', {})).toBe('C:\\Windows\\System32\\tasklist.exe');
  });

  it('refuses to answer when the process list parses to nothing', async () => {
    for (const out of ['', 'garbage\r\n', 'INFO: No tasks are running.\r\n']) {
      await expect(isStudioRunning({ platform: 'win32', run: fakeRunner(out) })).rejects.toThrow(
        'Could not read the process list',
      );
    }
    await expect(isStudioRunning({ platform: 'linux', run: fakeRunner('\n') })).rejects.toThrow(
      'Could not read the process list',
    );
  });

  it('detects the BambuStudio.exe name too', async () => {
    const out = '"BambuStudio.exe","1","Console","1","1 K"\r\n';
    expect(await isStudioRunning({ platform: 'win32', run: fakeRunner(out) })).toBe(true);
  });

  it('is false when Studio is not in the list', async () => {
    const out = '"explorer.exe","4321","Console","1","120,000 K"\r\n';
    expect(await isStudioRunning({ platform: 'win32', run: fakeRunner(out) })).toBe(false);
  });

  it('uses ps elsewhere', async () => {
    const calls: [string, string[]][] = [];
    const out = '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio\n';
    const fileExists = (f: string) => f === '/bin/ps';
    expect(
      await isStudioRunning({ platform: 'darwin', fileExists, run: fakeRunner(out, calls) }),
    ).toBe(true);
    expect(calls[0]?.[0]).toBe('/bin/ps');
    expect(processListProgram('linux', {}, () => false)).toBe('/usr/bin/ps');
    expect(await isStudioRunning({ platform: 'linux', run: fakeRunner('bash\n') })).toBe(false);
  });

  it('throws when the process list cannot be read', async () => {
    const run: CommandRunner = async () => {
      throw new Error('spawn tasklist ENOENT');
    };
    await expect(isStudioRunning({ platform: 'win32', run })).rejects.toThrow('ENOENT');
  });

  it('runs the real process list and returns a boolean', async () => {
    expect(typeof (await isStudioRunning())).toBe('boolean');
  });

  // Needs Bambu Studio open: npm run test:live -- studioProcess
  it.runIf(process.env['PRESET_DOCTOR_LIVE'] === '1')(
    'sees the running Bambu Studio (live)',
    async () => {
      expect(await isStudioRunning()).toBe(true);
    },
  );
});

describe('defaultPaths', () => {
  it('uses %APPDATA% on Windows', () => {
    expect(
      defaultPaths({ platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } }),
    ).toEqual({
      studioRoot: 'C:\\Users\\me\\AppData\\Roaming\\BambuStudio',
      backupsDir: 'C:\\Users\\me\\AppData\\Roaming\\PresetDoctor\\backups',
    });
  });

  it('falls back to the home folder when APPDATA is unset', () => {
    expect(defaultPaths({ platform: 'win32', env: {}, home: 'C:\\Users\\me' }).studioRoot).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\BambuStudio',
    );
  });

  it('uses Application Support on macOS and ~/.config on Linux', () => {
    expect(defaultPaths({ platform: 'darwin', env: {}, home: '/Users/me' })).toEqual({
      studioRoot: '/Users/me/Library/Application Support/BambuStudio',
      backupsDir: '/Users/me/Library/Application Support/PresetDoctor/backups',
    });
    expect(defaultPaths({ platform: 'linux', env: {}, home: '/home/me' }).studioRoot).toBe(
      '/home/me/.config/BambuStudio',
    );
  });
});
