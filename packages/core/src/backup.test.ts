import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BackupSession,
  BackupSourceError,
  MANIFEST_NAME,
  createBackup,
  formatBackupTimestamp,
  isBackupId,
  listBackups,
  restoreBackup,
} from './backup.js';
import { encodeText, joinPath, type PresetFs } from './fs.js';
import { memFs } from './memFs.js';
import { nodeFs } from './node/nodeFs.js';
import { fixtureRoot } from './testing/fixtures.js';

const T1 = new Date(2026, 10, 5, 17, 30, 0);
const T2 = new Date(2026, 10, 5, 18, 0, 5);

const PRESET = '{\n    "inherits": "Generic PETG @BBL X2D 0.6 nozzle",\n    "name": "A"\n}';
const INFO = 'sync_info = \nuser_id = 1000000001\nsetting_id = PFUS0000000000000001\n';

function studio(): Record<string, string | Uint8Array> {
  return {
    'BambuStudio.conf': '{}',
    'system/BBL.json': '{}',
    'user/1000000001/filament/A.json': PRESET,
    'user/1000000001/filament/A.info': INFO,
    'user/1000000001/filament/Crlf.json': '{\r\n    "name": "Crlf"\r\n}\r\n',
    'user/1000000001/filament/base/Bom.json': '\uFEFF{"name":"Bom"}',
    'user/1000000001/filament/Ünïcødé 0.6.json': '{"name":"Ü"}',
    'user/1000000001/thumb.bin': new Uint8Array([0, 1, 2, 255, 254, 0]),
  };
}

/** Every file under `dir`, as raw bytes keyed by path. */
async function tree(fs: PresetFs, dir: string): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.list(d)) {
      const p = joinPath(d, e.name);
      if (e.kind === 'dir') await walk(p);
      else out[p] = Array.from(await fs.readBytes(p));
    }
  };
  await walk(dir);
  return out;
}

describe('formatBackupTimestamp', () => {
  it('formats local time safely for file names', () => {
    expect(formatBackupTimestamp(T1)).toBe('2026-11-05T17-30-00');
    expect(formatBackupTimestamp(new Date(2027, 0, 2, 3, 4, 5))).toBe('2027-01-02T03-04-05');
  });

  it('recognises backup ids and rejects path tricks', () => {
    expect(isBackupId('2026-11-05T17-30-00')).toBe(true);
    expect(isBackupId('2026-11-05T17-30-00-3')).toBe(true);
    for (const bad of ['../x', '2026-11-05T17:30:00', '2026-11-05T17-30-00.zip', ''])
      expect(isBackupId(bad)).toBe(false);
  });
});

describe('createBackup', () => {
  it('zips only user/, with paths, bytes, empty folders and a manifest', async () => {
    const src = memFs(studio());
    await src.mkdir('user/default/filament');
    const dest = memFs();
    const info = await createBackup(src, dest, { now: T1 });

    expect(info).toMatchObject({
      id: '2026-11-05T17-30-00',
      path: '2026-11-05T17-30-00.zip',
      fileCount: 6,
      reason: 'before-fix',
      createdAt: T1.toISOString(),
    });
    const zip = await dest.readBytes(info.path);
    expect(info.bytes).toBe(zip.length);

    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual(
      [
        MANIFEST_NAME,
        'user/1000000001/filament/A.info',
        'user/1000000001/filament/A.json',
        'user/1000000001/filament/Crlf.json',
        'user/1000000001/filament/base/Bom.json',
        'user/1000000001/filament/Ünïcødé 0.6.json',
        'user/1000000001/thumb.bin',
        'user/default/filament/',
      ].sort(),
    );
    expect(Array.from(entries['user/1000000001/thumb.bin'] ?? [])).toEqual([0, 1, 2, 255, 254, 0]);
    expect(Array.from(entries['user/1000000001/filament/base/Bom.json'] ?? [])).toEqual(
      Array.from(encodeText('\uFEFF{"name":"Bom"}')),
    );
  });

  it('never writes to the Bambu Studio folder', async () => {
    const src = memFs(studio());
    const before = src.snapshot();
    await createBackup(src, memFs(), { now: T1 });
    expect(src.snapshot()).toEqual(before);
  });

  it('adds a suffix when a backup with the same second exists', async () => {
    const src = memFs(studio());
    const dest = memFs();
    const a = await createBackup(src, dest, { now: T1 });
    const b = await createBackup(src, dest, { now: T1 });
    const c = await createBackup(src, dest, { now: T1 });
    expect([a.id, b.id, c.id]).toEqual([
      '2026-11-05T17-30-00',
      '2026-11-05T17-30-00-2',
      '2026-11-05T17-30-00-3',
    ]);
  });

  it('fails clearly when there is no user folder', async () => {
    await expect(createBackup(memFs({ 'system/BBL.json': '{}' }), memFs())).rejects.toThrow(
      /no "user" folder/,
    );
  });

  it('fails when the saved zip does not read back the same', async () => {
    const dest = memFs();
    const corrupting: PresetFs = {
      ...dest,
      async writeBytes(p, data) {
        const entries = unzipSync(data);
        entries['user/1000000001/filament/A.json'] = encodeText('changed');
        await dest.writeBytes(p, zipSync(entries));
      },
    };
    await expect(createBackup(memFs(studio()), corrupting, { now: T1 })).rejects.toThrow();
  });
});

describe('listBackups', () => {
  it('lists newest first and ignores other files', async () => {
    const src = memFs(studio());
    const dest = memFs({ 'notes.txt': 'x', 'other.zip': 'not ours' });
    await createBackup(src, dest, { now: T1 });
    await createBackup(src, dest, { now: T2, reason: 'manual' });
    await createBackup(src, dest, { now: T1 });
    const list = await listBackups(dest);
    expect(list.map((b) => b.id)).toEqual([
      '2026-11-05T18-00-05',
      '2026-11-05T17-30-00-2',
      '2026-11-05T17-30-00',
    ]);
    expect(list[0]).toMatchObject({ fileCount: 6, reason: 'manual', createdAt: T2.toISOString() });
  });

  it('orders numeric suffixes as numbers', async () => {
    const src = memFs(studio());
    const dest = memFs();
    for (let i = 0; i < 10; i++) await createBackup(src, dest, { now: T1 });
    const ids = (await listBackups(dest)).map((b) => b.id);
    expect(ids.slice(0, 2)).toEqual(['2026-11-05T17-30-00-10', '2026-11-05T17-30-00-9']);
    expect(ids.at(-1)).toBe('2026-11-05T17-30-00');
  });

  it('returns nothing when the backups folder does not exist yet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'preset-doctor-backup-'));
    try {
      expect(await listBackups(nodeFs(join(root, 'missing')))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still lists a damaged zip', async () => {
    const dest = memFs({ '2026-01-01T00-00-00.zip': 'garbage' });
    expect(await listBackups(dest)).toMatchObject([{ id: '2026-01-01T00-00-00', fileCount: 0 }]);
  });

  it('orders by the UTC time in the manifest, so the repeated hour of a DST change sorts right', async () => {
    // Fall-back night: 01:50 in the first hour, then 01:10 in the repeated hour (40 min later).
    const zip = (createdAt: string) =>
      zipSync({
        'user/1/a.json': encodeText('{}'),
        [MANIFEST_NAME]: encodeText(
          JSON.stringify({ app: 'preset-doctor', formatVersion: 1, createdAt, fileCount: 1 }),
        ),
      });
    const dest = memFs({
      '2026-11-01T01-50-00.zip': zip('2026-11-01T05:50:00.000Z'),
      '2026-11-01T01-10-00.zip': zip('2026-11-01T06:10:00.000Z'),
    });
    expect((await listBackups(dest)).map((b) => b.id)).toEqual([
      '2026-11-01T01-10-00',
      '2026-11-01T01-50-00',
    ]);
  });

  it('lists the folder and accounts a backup came from', async () => {
    const dest = memFs();
    await createBackup(memFs(studio()), dest, { now: T1, sourceRoot: 'C:\\Data\\BambuStudio' });
    const [b] = await listBackups(dest);
    expect(b).toMatchObject({ sourceRoot: 'C:\\Data\\BambuStudio', accounts: ['1000000001'] });
  });
});

describe('restoreBackup', () => {
  it('backup -> modify -> restore gives byte-identical files (memFs)', async () => {
    const src = memFs(studio());
    const dest = memFs();
    const original = await tree(src, 'user');
    const backup = await createBackup(src, dest, { now: T1 });

    await src.writeText('user/1000000001/filament/A.json', PRESET.replace('0.6 nozzle', ''));
    await src.remove('user/1000000001/filament/A.info');
    await src.writeBytes('user/1000000001/thumb.bin', new Uint8Array([9]));
    await src.writeText('user/1000000001/filament/New.json', '{"name":"New"}');
    const modified = await tree(src, 'user');

    const result = await restoreBackup(src, dest, backup.id, { now: T2 });
    expect(result.restoredCount).toBe(6);

    const after = await tree(src, 'user');
    const { ['user/1000000001/filament/New.json']: extra, ...rest } = after;
    expect(rest).toEqual(original);
    expect(extra).toEqual(Array.from(encodeText('{"name":"New"}')));
    // Outside user/ is untouched.
    expect(await src.readText('BambuStudio.conf')).toBe('{}');

    // The safety backup holds the modified state, so the restore can itself be undone.
    expect(result.safetyBackup).toMatchObject({
      id: '2026-11-05T18-00-05',
      reason: 'before-restore',
    });
    await restoreBackup(src, dest, result.safetyBackup?.id ?? '');
    // A.info came back with the first restore and stays, because restore never deletes.
    expect(await tree(src, 'user')).toEqual({
      ...modified,
      'user/1000000001/filament/A.info': original['user/1000000001/filament/A.info'],
    });
  });

  it('recreates empty folders', async () => {
    const src = memFs(studio());
    await src.mkdir('user/default/filament');
    const dest = memFs();
    const b = await createBackup(src, dest, { now: T1 });
    await src.remove('user/default');
    await restoreBackup(src, dest, b.id, { now: T2 });
    expect(await src.list('user/default/filament')).toEqual([]);
  });

  it('refuses a backup taken from another folder unless told otherwise', async () => {
    const copy = memFs(studio());
    const dest = memFs();
    const b = await createBackup(copy, dest, { now: T1, sourceRoot: 'D:\\Copy\\BambuStudio' });
    const live = memFs(studio());
    await live.writeText('user/1000000001/filament/A.json', '{"name":"Live"}');
    const before = live.snapshot();

    const err = await restoreBackup(live, dest, b.id, {
      now: T2,
      expectedRoot: 'C:\\AppData\\BambuStudio',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupSourceError);
    expect((err as BackupSourceError).sourceRoot).toBe('D:\\Copy\\BambuStudio');
    expect(live.snapshot()).toEqual(before);
    expect(await listBackups(dest)).toHaveLength(1);

    // The same folder in other spelling is fine; so is an explicit override.
    await restoreBackup(copy, dest, b.id, { now: T2, expectedRoot: 'd:/copy/bambustudio/' });
    const r = await restoreBackup(live, dest, b.id, {
      now: T2,
      expectedRoot: 'C:\\AppData\\BambuStudio',
      allowOtherSource: true,
    });
    expect(r.restoredCount).toBe(6);
    expect(r.safetyBackup?.sourceRoot).toBe('C:\\AppData\\BambuStudio');
  });

  it('rejects unknown or unsafe ids without writing', async () => {
    const src = memFs(studio());
    const before = src.snapshot();
    await expect(restoreBackup(src, memFs(), '2026-01-01T00-00-00')).rejects.toThrow(/not found/);
    await expect(restoreBackup(src, memFs(), '../evil')).rejects.toThrow(/Not a backup name/);
    expect(src.snapshot()).toEqual(before);
  });

  it('refuses a zip with entries outside user/ before changing anything', async () => {
    const dest = memFs({
      '2026-01-01T00-00-00.zip': zipSync({
        'user/1/a.json': encodeText('x'),
        'BambuStudio.conf': encodeText('evil'),
      }),
    });
    const src = memFs(studio());
    const before = src.snapshot();
    await expect(restoreBackup(src, dest, '2026-01-01T00-00-00')).rejects.toThrow(/outside "user"/);
    expect(src.snapshot()).toEqual(before);
    expect((await dest.list('')).length).toBe(1);
  });
});

describe('BackupSession', () => {
  it('makes exactly one backup however often it is asked, even concurrently', async () => {
    const src = memFs(studio());
    const dest = memFs();
    const session = new BackupSession(src, dest, { now: T1 });
    expect(session.backup).toBeNull();
    const [a, b] = await Promise.all([session.ensureBackupOnce(), session.ensureBackupOnce()]);
    const c = await session.ensureBackupOnce();
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(session.backup).toBe(a);
    expect(await listBackups(dest)).toHaveLength(1);
  });

  it('retries after a failure', async () => {
    const src = memFs({ 'system/BBL.json': '{}' });
    const dest = memFs();
    const session = new BackupSession(src, dest, { now: T1 });
    await expect(session.ensureBackupOnce()).rejects.toThrow();
    await src.writeText('user/1/a.json', '{}');
    expect((await session.ensureBackupOnce()).fileCount).toBe(1);
  });
});

describe('with nodeFs on a temp copy of a fixture', () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
  });

  function osTree(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else out[relative(root, p).split('\\').join('/')] = readFileSync(p).toString('base64');
      }
    };
    walk(root);
    return out;
  }

  it('backup -> modify -> restore is byte-identical on disk', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'preset-doctor-backup-'));
    temps.push(tmp);
    const studioDir = join(tmp, 'BambuStudio');
    const backupsDir = join(tmp, 'PresetDoctor', 'backups');
    cpSync(fixtureRoot('multi-account'), studioDir, { recursive: true });
    const original = osTree(studioDir);

    const src = nodeFs(studioDir);
    const dest = nodeFs(backupsDir);
    const backup = await createBackup(src, dest, { now: T1 });
    expect(backup.fileCount).toBe(
      Object.keys(original).filter((p) => p.startsWith('user/')).length,
    );
    expect(readdirSync(backupsDir)).toEqual([backup.path]);

    const presets = (await src.list('user/1000000001/filament')).filter((e) => e.kind === 'file');
    const target = joinPath('user/1000000001/filament', presets[0]?.name ?? '');
    await src.writeText(target, 'broken');
    await src.remove(joinPath('user/1000000001/filament', presets[1]?.name ?? ''));

    const result = await restoreBackup(src, dest, backup.id, { now: T2 });
    expect(osTree(studioDir)).toEqual(original);
    expect(readdirSync(backupsDir).sort()).toEqual(
      [backup.path, result.safetyBackup?.path ?? ''].sort(),
    );
    expect((await listBackups(dest)).map((b) => b.id)).toEqual([
      '2026-11-05T18-00-05',
      '2026-11-05T17-30-00',
    ]);
  });
});
