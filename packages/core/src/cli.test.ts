import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, main, type CliDeps } from './cli.js';
import { fixtureRoot } from './testing/fixtures.js';
import { tempFixture } from './testing/studio.js';
import type { ScanResult } from './types.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

interface Run {
  code: number;
  out: string;
  err: string;
}

function setup(fixture: Parameters<typeof tempFixture>[0] = 'broken-r1') {
  const t = tempFixture(fixture);
  cleanups.push(t.cleanup);
  const backupsDir = join(t.dir, '..', 'backups');
  let running = false;
  let checkFails = false;
  let onCheck: (() => void) | undefined;
  const run = async (...argv: string[]): Promise<Run> => {
    let out = '';
    let err = '';
    const deps: Partial<CliDeps> = {
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
      paths: { studioRoot: t.dir, backupsDir },
      isStudioRunning: async () => {
        onCheck?.();
        if (checkFails) throw new Error('tasklist failed');
        return running;
      },
      now: () => new Date(2026, 10, 5, 17, 30, 0),
    };
    const code = await main(argv, deps);
    return { code, out, err };
  };
  return {
    root: t.dir,
    backupsDir,
    run,
    setRunning: (v: boolean) => (running = v),
    failCheck: () => (checkFails = true),
    /** Runs when the CLI checks for Studio: after planning, before any backup or write. */
    onStudioCheck: (fn: () => void) => (onCheck = fn),
    read: (rel: string) => readFileSync(join(t.dir, rel), 'utf8'),
  };
}

const PETG06 = 'user/1000000001/filament/Anycubic Petg 06.json';
const ADDED_INFO = 'user/1000000001/filament/Synthetic Added Suffix.info';

describe('preset-doctor CLI', () => {
  it('prints help and the version', async () => {
    const { run } = setup('healthy');
    for (const argv of [['--help'], ['-h'], [], ['help']]) {
      const r = await run(...argv);
      expect(r.code).toBe(EXIT.ok);
      expect(r.out).toContain('Usage:');
      expect(r.out).toContain('Exit codes:');
    }
    expect((await run('--version')).out).toBe('0.1.0\n');
  });

  it('rejects unknown commands and options', async () => {
    const { run } = setup('healthy');
    expect((await run('frobnicate')).code).toBe(EXIT.usage);
    const r = await run('scan', '--colour');
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain('Unknown option --colour.');
    expect((await run('scan', '--user')).code).toBe(EXIT.usage);
    expect((await run('scan', 'a', 'b')).code).toBe(EXIT.usage);
  });

  it('treats a folder named like an Object.prototype key as a folder, not a flag', async () => {
    const t = tempFixture('healthy');
    cleanups.push(t.cleanup);
    // The default root must never be used in place of the folder that was named.
    const missingDefault = join(t.dir, 'no-such-default-root');
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      let err = '';
      const code = await main(['scan', name], {
        stdout: () => {},
        stderr: (s) => (err += s),
        paths: { studioRoot: missingDefault, backupsDir: join(t.dir, 'backups') },
        isStudioRunning: async () => false,
      });
      expect(code).toBe(EXIT.failed);
      expect(err).toContain(`The folder ${name} does not exist.`);
      expect(err).not.toContain(missingDefault);
    }
  });

  it('scan: groups presets by status and exits 1 when some are hidden', async () => {
    const { run } = setup();
    const r = await run('scan');
    expect(r.code).toBe(EXIT.problems);
    expect(r.out).toContain('System presets: version 02.08.00.06');
    expect(r.out).toContain('Account: 1000000001 (24 presets)');
    expect(r.out).toContain('WARNING: Cloud preset sync is on.');
    expect(r.out).toContain('Hidden in Studio (22)');
    expect(r.out).toContain('Parent "Generic PETG @BBL X2D 0.6 nozzle" is missing');
    expect(r.out).toContain('fix: switch parent to "Generic PETG @BBL X2D" (high confidence)');
    expect(r.out).toContain('Synthetic No Candidates');
    expect(r.out).toContain('no replacement found');
    expect(r.out).toContain('Summary: 22 hidden, 0 broken, 0 OK with notes, 2 OK.');
  });

  it('scan: exits 0 on a healthy folder, and --json prints the ScanResult', async () => {
    const { run, root } = setup('healthy');
    expect((await run('scan', root)).code).toBe(EXIT.ok);
    const r = await run('scan', root, '--json');
    const parsed = JSON.parse(r.out) as ScanResult;
    expect(parsed.userId).toBe('1000000001');
    expect(parsed.findings).toEqual([]);
  });

  it('scan: --user picks the account; bad folders and accounts exit 3', async () => {
    const { run } = setup('multi-account');
    expect((await run('scan', '--user', '1000000002')).out).toContain('Hidden in Studio (3)');
    expect((await run('scan', '--user=default')).code).toBe(EXIT.ok);
    const bad = await run('scan', '--user', '42');
    expect(bad.code).toBe(EXIT.failed);
    expect(bad.err).toContain('There is no account folder "42"');
    const missing = await run('scan', join(fixtureRoot('healthy'), 'nope'));
    expect(missing.code).toBe(EXIT.failed);
    expect(missing.err).toContain('does not exist');
  });

  it('fix --dry-run: prints diffs and writes nothing', async () => {
    const { run, read } = setup();
    const before = read(PETG06);
    const r = await run('fix', '--dry-run');
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('20 file change(s) planned:');
    expect(r.out).toContain('-    "inherits": "Generic PETG @BBL X2D 0.6 nozzle",');
    expect(r.out).toContain('+    "inherits": "Generic PETG @BBL X2D",');
    expect(r.out).toContain('-base_id = GFSG99_15');
    expect(r.out).toContain('Not repaired automatically');
    expect(r.out).toContain('Dry run: nothing was written.');
    expect(read(PETG06)).toBe(before);
  });

  it('fix --no-base-id leaves sidecars out of the plan', async () => {
    const { run } = setup();
    const r = await run('fix', '--no-base-id');
    expect(r.out).toContain('19 file change(s) planned:');
    expect(r.out).not.toContain('base_id');
  });

  it('fix: the printed next command keeps --user, --no-base-id and --backups', async () => {
    const s = setup('multi-account');
    const dry = await s.run(
      'fix',
      '--user',
      '1000000002',
      '--no-base-id',
      '--backups',
      s.backupsDir,
    );
    expect(dry.code).toBe(EXIT.ok);
    expect(dry.out).toContain('Dry run: nothing was written.');
    const hint = dry.out.split('\n').find((l) => l.includes('--apply --yes'))!;
    expect(hint).toContain(' --user 1000000002 --apply --yes --no-base-id --backups ');

    // Several accounts: the hint names the one scanned even when --user wasn't given, since
    // the default could change (e.g. after presets are added to another account).
    const scanned = await s.run('scan', '--user', '1000000002');
    expect(scanned.out).toMatch(
      /To preview repairs: preset-doctor fix .* --user 1000000002 --dry-run/,
    );
    const single = setup();
    expect((await single.run('fix')).out).not.toContain('--user');
  });

  it('fix --apply: needs --yes and a closed Studio, else writes nothing', async () => {
    const s = setup();
    const before = s.read(PETG06);

    expect((await s.run('fix', '--apply')).code).toBe(EXIT.usage);
    expect((await s.run('fix', '--apply', '--dry-run', '--yes')).code).toBe(EXIT.usage);

    s.setRunning(true);
    const running = await s.run('fix', '--apply', '--yes');
    expect(running.code).toBe(EXIT.refused);
    expect(running.err).toContain('Bambu Studio is running');

    s.setRunning(false);
    s.failCheck();
    const unknown = await s.run('fix', '--apply', '--yes');
    expect(unknown.code).toBe(EXIT.refused);
    expect(unknown.err).toContain('Could not check whether Bambu Studio is running');

    expect(s.read(PETG06)).toBe(before);
    expect(existsSync(s.backupsDir)).toBe(false);
  });

  it('fix --apply: a planned file deleted after planning is stale, and nothing is backed up', async () => {
    const s = setup();
    s.onStudioCheck(() => rmSync(join(s.root, ...PETG06.split('/'))));
    const r = await s.run('fix', '--apply', '--yes');
    expect(r.code).toBe(EXIT.refused);
    expect(r.err).toContain('changed since the fix was planned');
    expect(r.err).toContain(PETG06);
    expect(r.err).not.toContain('does not include');
    expect(existsSync(s.backupsDir)).toBe(false);
  });

  it('fix --apply --yes: backs up, repairs, and backups restore undoes it', async () => {
    const s = setup();
    const before = s.read(PETG06);
    const infoBefore = s.read(ADDED_INFO);

    const r = await s.run('fix', '--apply', '--yes');
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('(backup 2026-11-05T17-30-00)');
    expect(r.out).toContain('Done: changed 20 file(s).');
    expect(r.out).toContain('preset-doctor backups restore 2026-11-05T17-30-00');
    expect(readdirSync(s.backupsDir)).toEqual(['2026-11-05T17-30-00.zip']);
    expect(s.read(PETG06)).toContain('"inherits": "Generic PETG @BBL X2D",');
    expect(s.read(ADDED_INFO)).toContain('base_id = GFSB00\r\n');

    const rescan = await s.run('scan');
    expect(rescan.out).toContain('Hidden in Studio (3)');

    const list = await s.run('backups');
    expect(list.out).toContain('2026-11-05T17-30-00');
    expect(list.out).toContain('before-fix');

    expect((await s.run('backups', 'restore', '2026-11-05T17-30-00')).code).toBe(EXIT.usage);
    const restore = await s.run('backups', 'restore', '2026-11-05T17-30-00', s.root, '--yes');
    expect(restore.code).toBe(EXIT.ok);
    expect(restore.out).toContain('saved as backup 2026-11-05T17-30-00-2');
    expect(s.read(PETG06)).toBe(before);
    expect(s.read(ADDED_INFO)).toBe(infoBefore);
  });

  it('scan: exits 3, not 0, when the system presets are missing or corrupt', async () => {
    // 'no-presets': BBL.json copied without the system/BBL folder (a partial copy for the web
    // version, or a half-done update): unknown, not 'every parent is gone'.
    for (const damage of ['remove', 'corrupt', 'no-presets'] as const) {
      const s = setup('healthy');
      const index = join(s.root, 'system', 'BBL.json');
      if (damage === 'remove') rmSync(index);
      else if (damage === 'corrupt') writeFileSync(index, '{ half-written');
      else rmSync(join(s.root, 'system', 'BBL'), { recursive: true });
      const r = await s.run('scan');
      expect(r.code, damage).toBe(EXIT.failed);
      expect(r.out).toContain('System presets: could not be read');
      expect(r.out).toContain('INCOMPLETE: the system presets could not be read');
      expect(r.out).toContain('could not be checked (system presets unreadable)');
      // Only the 3 wizard presets (no parent) count as OK; the 10 with a parent were not checked.
      expect(r.out).toContain('OK, with notes (10)');
      expect(r.out).toMatch(/^OK \(3\)$/m);
      expect((await s.run('scan', '--json')).code).toBe(EXIT.failed);
    }
  });

  it('backups restore: refuses a backup made from another folder unless asked', async () => {
    const copy = setup();
    expect((await copy.run('fix', '--apply', '--yes')).code).toBe(EXIT.ok);
    const repaired = copy.read(PETG06);
    const listed = await copy.run('backups');
    expect(listed.out).toContain(`from ${copy.root}`);

    // The live folder is the default target; the backup came from the copy.
    const live = setup();
    const before = live.read(PETG06);
    const restoreInto = (...extra: string[]) =>
      copy.run('backups', 'restore', '2026-11-05T17-30-00', live.root, '--yes', ...extra);
    const refused = await restoreInto();
    expect(refused.code).toBe(EXIT.refused);
    expect(refused.err).toContain(`This backup was made from ${copy.root}`);
    expect(refused.err).toContain('--from-other-folder');
    expect(live.read(PETG06)).toBe(before);

    expect((await restoreInto('--from-other-folder')).code).toBe(EXIT.ok);
    expect(copy.read(PETG06)).toBe(repaired);
  });

  it('backups restore: a restore that stops part-way names the safety backup', async () => {
    const s = setup();
    expect((await s.run('fix', '--apply', '--yes')).code).toBe(EXIT.ok);
    // A folder where a preset file should be: the restore can't write it, on any OS.
    rmSync(join(s.root, ...PETG06.split('/')));
    mkdirSync(join(s.root, ...PETG06.split('/')));

    const r = await s.run('backups', 'restore', '2026-11-05T17-30-00', s.root, '--yes');
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toContain(
      'The restore stopped part-way at user/1000000001/filament/Anycubic Petg 06.json',
    );
    expect(r.err).toMatch(/\d+ file\(s\) were already put back/);
    expect(r.err).toContain(
      'To go back to how it was before this restore: preset-doctor backups restore 2026-11-05T17-30-00-2',
    );
  }, 20000);

  it('backups: empty list, unknown subcommand, unknown id', async () => {
    const s = setup('healthy');
    expect((await s.run('backups', 'list')).out).toContain('No backups in');
    expect((await s.run('backups', 'prune')).code).toBe(EXIT.usage);
    const r = await s.run('backups', 'restore', '2020-01-01T00-00-00', '--yes');
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toContain('was not found');
  });
});
