import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PresetFs } from '@preset-doctor/core';
import { nodeFs, type NodeFsOptions } from '@preset-doctor/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcResult } from '../shared/api.js';
import { DoctorService, type ServiceDeps } from './service.js';

const FIXTURE = fileURLToPath(
  new URL('../../../../packages/core/src/__fixtures__/broken-r1', import.meta.url),
);
const ORPHAN = 'user/1000000001/filament/Anycubic Petg 06.json';

let work: string;
let root: string;
let backups: string;
let studio: () => Promise<boolean>;

function makeService(fake: boolean | null = null, extra: Partial<ServiceDeps> = {}): DoctorService {
  return new DoctorService({
    config: {
      root,
      slicerRoots: { bambu: join(work, 'no-bambu'), orca: join(work, 'no-orca') },
      backupsDir: backups,
      testMode: true,
      fakeStudioRunning: fake,
    },
    isStudioRunning: () => studio(),
    version: '9.9.9',
    donationUrl: '',
    ...extra,
  });
}

function ok<T>(r: IpcResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function errCode(r: IpcResult<unknown>): string {
  return r.ok ? 'ok' : r.error.code;
}

async function zipCount(): Promise<number> {
  try {
    return (await readdir(backups)).filter((f) => f.endsWith('.zip')).length;
  } catch {
    return 0;
  }
}

const readRoot = (p: string): Promise<string> => readFile(join(root, ...p.split('/')), 'utf8');

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'pd-desktop-'));
  root = join(work, 'BambuStudio');
  backups = join(work, 'backups');
  await cp(FIXTURE, root, { recursive: true });
  studio = () => Promise.resolve(false);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('DoctorService', () => {
  it('reports its config', async () => {
    const cfg = ok(await makeService().getConfig());
    expect(cfg).toMatchObject({ root, rootExists: true, backupsDir: backups, version: '9.9.9' });
  });

  it('only scans folders it was given', async () => {
    const s = makeService();
    expect(errCode(await s.scan(work, undefined))).toBe('invalid');
    expect(errCode(await s.scan(42, undefined))).toBe('invalid');
    const { result, defaults } = ok(await s.scan(root, undefined));
    expect(result.userId).toBe('1000000001');
    expect(result.presets.filter((p) => p.status === 'hidden')).toHaveLength(22);
    expect(defaults.find((d) => d.presetPath === ORPHAN)?.candidateName).toBe(
      'Generic PETG @BBL X2D',
    );
  });

  it('accepts a picked user\\ folder as its Studio folder', async () => {
    const s = makeService();
    const adopted = await s.adoptFolder(join(root, 'user'));
    expect(adopted).toBe(root);
    expect(errCode(await s.scan(adopted, undefined))).toBe('ok');
  });

  it('reports a non-Studio folder as a scan failure', async () => {
    const s = makeService();
    const picked = await s.adoptFolder(backups);
    expect(errCode(await s.scan(picked, undefined))).toBe('scan-failed');
  });

  it('plans with one-line diffs and validates choices', async () => {
    const s = makeService();
    expect(errCode(await s.plan([], {}))).toBe('invalid');
    const { defaults } = ok(await s.scan(root, undefined));
    expect(errCode(await s.plan('nope', {}))).toBe('invalid');
    expect(errCode(await s.plan([{ presetPath: ORPHAN, candidateName: 'Made Up' }], {}))).toBe(
      'invalid',
    );
    const plan = ok(await s.plan(defaults, { updateBaseId: true }));
    const orphan = plan.changes.find((c) => c.path === ORPHAN);
    expect(orphan?.diff).toContain('+    "inherits": "Generic PETG @BBL X2D",');
  });

  it('refuses to write while Studio runs, or when it cannot tell', async () => {
    const s = makeService();
    const { defaults } = ok(await s.scan(root, undefined));
    const { planId } = ok(await s.plan(defaults, { updateBaseId: true }));
    const before = await readRoot(ORPHAN);

    studio = () => Promise.resolve(true);
    expect(errCode(await s.apply(planId))).toBe('studio-running');
    studio = () => Promise.reject(new Error('tasklist failed'));
    expect(errCode(await s.apply(planId))).toBe('studio-unknown');
    expect(errCode(await s.studioStatus())).toBe('ok');
    expect(ok(await s.studioStatus())).toBe('unknown');

    expect(await readRoot(ORPHAN)).toBe(before);
    expect(await zipCount()).toBe(0);
  });

  it('honors the fake Studio flag', async () => {
    studio = () => Promise.resolve(false);
    expect(ok(await makeService(true).studioStatus())).toBe('running');
    studio = () => Promise.resolve(true);
    expect(ok(await makeService(false).studioStatus())).toBe('closed');
  });

  it('backs up once per session, applies, and forgets old previews', async () => {
    const s = makeService();
    const { defaults } = ok(await s.scan(root, undefined));
    const first = ok(await s.plan(defaults.slice(0, 1), { updateBaseId: true }));
    const second = ok(await s.plan(defaults.slice(1), { updateBaseId: true }));

    const a = ok(await s.apply(first.planId));
    expect(a.backupIsNew).toBe(true);
    expect(a.written).toHaveLength(1);
    // Applying invalidates every other preview, since the files changed.
    expect(errCode(await s.apply(second.planId))).toBe('invalid');

    const rescan = ok(await s.scan(root, undefined));
    const b = ok(await s.apply(ok(await s.plan(rescan.defaults, { updateBaseId: true })).planId));
    expect(b.backupIsNew).toBe(false);
    expect(b.backup.id).toBe(a.backup.id);
    expect(await zipCount()).toBe(1);
    expect(await readRoot(ORPHAN)).toContain('"inherits": "Generic PETG @BBL X2D",');
  });

  it('refuses a stale plan without writing anything', async () => {
    const s = makeService();
    const { defaults } = ok(await s.scan(root, undefined));
    const { planId } = ok(await s.plan(defaults, { updateBaseId: true }));
    const path = join(root, ...ORPHAN.split('/'));
    await writeFile(path, (await readFile(path, 'utf8')) + ' ');
    const other = defaults.find((d) => d.presetPath !== ORPHAN)!.presetPath;
    const otherBefore = await readRoot(other);

    expect(errCode(await s.apply(planId))).toBe('stale');
    expect(await readRoot(other)).toBe(otherBefore);
  });

  it('refuses a plan whose file was deleted since, before making any backup', async () => {
    const s = makeService();
    const { defaults } = ok(await s.scan(root, undefined));
    const { planId } = ok(await s.plan(defaults, { updateBaseId: true }));
    await rm(join(root, ...ORPHAN.split('/')));
    // Stale, not "the backup doesn't include it", and no backup for nothing.
    expect(errCode(await s.apply(planId))).toBe('stale');
    expect(await zipCount()).toBe(0);

    // Same with a session backup already made: no second, useless one either.
    const rescan = ok(await s.scan(root, undefined));
    ok(await s.apply(ok(await s.plan(rescan.defaults.slice(0, 1), {})).planId));
    const added = 'user/1000000001/filament/Added Petg 06.json';
    const text = (await readFile(join(FIXTURE, ...ORPHAN.split('/')), 'utf8')).replace(
      /"name": "[^"]*"/,
      '"name": "Added Petg 06"',
    );
    await writeFile(join(root, ...added.split('/')), text);
    const third = ok(await s.scan(root, undefined));
    const plan = ok(
      await s.plan(
        third.defaults.filter((c) => c.presetPath === added),
        {},
      ),
    );
    await rm(join(root, ...added.split('/')));
    expect(errCode(await s.apply(plan.planId))).toBe('stale');
    expect(await zipCount()).toBe(1);
  });

  it('refuses to write what the backup does not hold, and drops the session', async () => {
    // A listing that misses ORPHAN (as for a link it can't follow) while reads still work.
    const orphanName = ORPHAN.slice(ORPHAN.lastIndexOf('/') + 1);
    let hide = true;
    const fsFor = (dir: string, options?: NodeFsOptions): PresetFs => {
      const fs = nodeFs(dir, options);
      if (resolve(dir) !== resolve(root) || options?.readOnly) return fs;
      return {
        ...fs,
        list: async (d) =>
          (await fs.list(d)).filter(
            (e) => !(hide && d === 'user/1000000001/filament' && e.name === orphanName),
          ),
      };
    };
    const s = makeService(null, { fsFor });
    const { defaults } = ok(await s.scan(root, undefined));
    const other = defaults.find((d) => d.presetPath !== ORPHAN)!.presetPath;
    const orphanBefore = await readRoot(ORPHAN);
    const otherBefore = await readRoot(other);

    const r = await s.apply(ok(await s.plan(defaults, { updateBaseId: true })).planId);
    expect(errCode(r)).toBe('failed');
    expect(r.ok ? '' : r.error.message).toContain(orphanName);
    expect(r.ok ? '' : r.error.message).toContain('Move those files back');
    expect(await readRoot(ORPHAN)).toBe(orphanBefore);
    expect(await readRoot(other)).toBe(otherBefore);

    // The session was dropped, so the next repair makes a backup that holds the file.
    hide = false;
    const rescan = ok(await s.scan(root, undefined));
    const again = ok(await s.apply(ok(await s.plan(rescan.defaults, {})).planId));
    expect(again.backupIsNew).toBe(true);
    expect(await zipCount()).toBe(2);
  });

  it('reports a thrown non-Error as a failure with its text', async () => {
    const s = makeService(null, {
      now: () => {
        throw 'boom';
      },
    });
    const { defaults } = ok(await s.scan(root, undefined));
    const r = await s.apply(ok(await s.plan(defaults, {})).planId);
    expect(r).toEqual({ ok: false, error: { code: 'failed', message: 'boom' } });
  });

  it('restores a backup, but not while Studio runs', async () => {
    const s = makeService();
    const original = await readRoot(ORPHAN);
    const { defaults } = ok(await s.scan(root, undefined));
    const applied = ok(await s.apply(ok(await s.plan(defaults, { updateBaseId: true })).planId));
    expect(await readRoot(ORPHAN)).not.toBe(original);

    expect(errCode(await s.restore(root, '../../etc'))).toBe('invalid');
    expect(errCode(await s.restore(work, applied.backup.id))).toBe('invalid');
    studio = () => Promise.resolve(true);
    expect(errCode(await s.restore(root, applied.backup.id))).toBe('studio-running');
    studio = () => Promise.resolve(false);

    const restored = ok(await s.restore(root, applied.backup.id));
    expect(restored.restoredCount).toBeGreaterThan(0);
    expect(restored.safetyBackup).not.toBeNull();
    expect(await readRoot(ORPHAN)).toBe(original);
    expect(ok(await s.listBackups())).toHaveLength(2);
  });

  it('reports a restore that stops part-way, with the backup that undoes it', async () => {
    const s = makeService();
    const { defaults } = ok(await s.scan(root, undefined));
    const applied = ok(await s.apply(ok(await s.plan(defaults, { updateBaseId: true })).planId));
    // A folder where the preset file should be: the restore can't write it.
    const path = join(root, ...ORPHAN.split('/'));
    await rm(path);
    await mkdir(path);

    const r = await s.restore(root, applied.backup.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('partial');
    expect(r.error.message).toContain('The restore stopped part-way at');
    // The backup it names is the one made just before the restore, not the one restored.
    expect(r.error.backupId).toBeDefined();
    expect(r.error.backupId).not.toBe(applied.backup.id);
    expect(r.error.message).toContain(`restore backup ${r.error.backupId}`);
    const safety = ok(await s.listBackups()).find((b) => b.id === r.error.backupId);
    expect(safety?.reason).toBe('before-restore');

    // The session's backup no longer matches the files, so the next repair makes a new one.
    await rm(path, { recursive: true });
    await cp(join(FIXTURE, ...ORPHAN.split('/')), path);
    const rescan = ok(await s.scan(root, undefined));
    const again = ok(
      await s.apply(ok(await s.plan(rescan.defaults, { updateBaseId: true })).planId),
    );
    expect(again.backupIsNew).toBe(true);
  }, 20000);

  it('makes a fresh backup when a file to repair was added after the session backup', async () => {
    const s = makeService();
    const { defaults } = ok(await s.scan(root, undefined));
    const first = ok(await s.apply(ok(await s.plan(defaults, { updateBaseId: true })).planId));

    const added = 'user/1000000001/filament/Added Petg 06.json';
    const text = (await readFile(join(FIXTURE, ...ORPHAN.split('/')), 'utf8')).replace(
      /"name": "[^"]*"/,
      '"name": "Added Petg 06"',
    );
    await writeFile(join(root, ...added.split('/')), text);
    const rescan = ok(await s.scan(root, undefined));
    const plan = ok(
      await s.plan(
        rescan.defaults.filter((c) => c.presetPath === added),
        { updateBaseId: true },
      ),
    );
    expect(plan.changes.map((c) => c.path)).toContain(added);
    const second = ok(await s.apply(plan.planId));
    expect(second.backupIsNew).toBe(true);
    expect(second.backup.id).not.toBe(first.backup.id);
    expect(await zipCount()).toBe(2);
  });

  it('restores into the folder the UI names, not the last one scanned', async () => {
    const s = makeService();
    const { defaults } = ok(await s.scan(root, undefined));
    const applied = ok(await s.apply(ok(await s.plan(defaults, { updateBaseId: true })).planId));
    const repaired = await readRoot(ORPHAN);
    expect(ok(await s.listBackups())[0]?.sourceRoot).toBe(root);

    // The user switches to another folder whose scan fails (no user\ or system\ yet).
    const other = join(work, 'Other');
    await mkdir(other);
    const picked = await s.adoptFolder(other);
    expect(errCode(await s.scan(picked, undefined))).toBe('scan-failed');
    expect(errCode(await s.plan(defaults, { updateBaseId: true }))).toBe('invalid');

    // The backup came from the first folder, so restoring it into the other one needs a yes.
    expect(errCode(await s.restore(picked, applied.backup.id))).toBe('other-source');
    expect(await readdir(other)).toEqual([]);
    ok(await s.restore(picked, applied.backup.id, { allowOtherSource: true }));
    expect(await readdir(other)).toEqual(['user']);
    expect(await readRoot(ORPHAN)).toBe(repaired);
  });

  it('makes a fresh backup when Studio ran since the last one', async () => {
    const s = makeService();
    const { defaults } = ok(await s.scan(root, undefined));
    const a = ok(await s.apply(ok(await s.plan(defaults.slice(0, 1), {})).planId));

    // The user opens Studio to check (the poll sees it), then closes it again.
    studio = () => Promise.resolve(true);
    expect(ok(await s.studioStatus())).toBe('running');
    studio = () => Promise.resolve(false);

    const rescan = ok(await s.scan(root, undefined));
    const b = ok(await s.apply(ok(await s.plan(rescan.defaults, {})).planId));
    expect(b.backupIsNew).toBe(true);
    expect(b.backup.id).not.toBe(a.backup.id);
    expect(await zipCount()).toBe(2);
  });

  it('applies the fake Studio flag only to the folder it was started on', async () => {
    studio = () => Promise.resolve(true);
    const s = makeService(false);
    const other = join(work, 'Other');
    await cp(FIXTURE, other, { recursive: true });
    const picked = await s.adoptFolder(other);
    const { defaults } = ok(await s.scan(picked, undefined));
    const { planId } = ok(await s.plan(defaults, { updateBaseId: true }));
    expect(errCode(await s.apply(planId))).toBe('studio-running');
    expect(ok(await s.studioStatus())).toBe('running');
  });
});

describe('DoctorService with OrcaSlicer', () => {
  const ORCA_FIXTURE = fileURLToPath(
    new URL('../../../../packages/core/src/__fixtures__/orca', import.meta.url),
  );
  let orcaRoot: string;
  let running: string[];

  beforeEach(async () => {
    orcaRoot = join(work, 'OrcaSlicer');
    await cp(ORCA_FIXTURE, orcaRoot, { recursive: true });
    running = [];
  });

  const service = (startRoot = root): DoctorService =>
    new DoctorService({
      config: {
        root: startRoot,
        slicerRoots: { bambu: root, orca: orcaRoot },
        backupsDir: backups,
        testMode: true,
        fakeStudioRunning: null,
      },
      isStudioRunning: (slicer) => Promise.resolve(running.includes(slicer)),
      version: '9.9.9',
      donationUrl: '',
    });

  it('lists both slicers, and scans the other default folder without picking it', async () => {
    const s = service();
    const cfg = ok(await s.getConfig());
    expect(cfg.slicers).toEqual([
      { id: 'bambu', displayName: 'Bambu Studio', root, exists: true },
      { id: 'orca', displayName: 'OrcaSlicer', root: orcaRoot, exists: true },
    ]);
    const { result } = ok(await s.scan(orcaRoot, undefined));
    expect(result.slicer).toBe('orca');
    expect(result.slicerVersion).toBe('2.3.2-rc');
  });

  it('checks the slicer of the folder it writes to, and names it', async () => {
    const s = service();
    const { defaults } = ok(await s.scan(orcaRoot, undefined));
    running = ['bambu'];
    const { planId } = ok(await s.plan(defaults, {}));
    const applied = ok(await s.apply(planId));
    expect(applied.backup.slicer).toBe('orca');

    running = ['orca'];
    expect(ok(await s.studioStatus())).toBe('running');
    ok(await s.scan(orcaRoot, undefined));
    const renamed = {
      presetPath: 'user/default/filament/Renamed.json',
      candidateName: 'Generic ABS @MyToolChanger',
    };
    const r = await s.apply(ok(await s.plan([renamed], {})).planId);
    expect(r.ok ? '' : r.error.message).toMatch(/^OrcaSlicer is open\./);
    expect(errCode(await s.restore(orcaRoot, applied.backup.id))).toBe('studio-running');
  });

  it("refuses to restore one slicer's backup into the other slicer's folder", async () => {
    const s = service();
    const { defaults } = ok(await s.scan(orcaRoot, undefined));
    const applied = ok(await s.apply(ok(await s.plan(defaults, {})).planId));
    const r = await s.restore(root, applied.backup.id, { allowOtherSource: true });
    expect(errCode(r)).toBe('other-slicer');
    expect(r.ok ? '' : r.error.message).toMatch(/made from an OrcaSlicer folder/);
    const back = ok(await s.restore(orcaRoot, applied.backup.id));
    expect(back.skipped).toEqual(['user/default/filament/Lone.info']);
  });

  it('accepts a picked system\\ folder of OrcaSlicer', async () => {
    expect(await service().adoptFolder(join(orcaRoot, 'system'))).toBe(orcaRoot);
  });

  it('starts on the OrcaSlicer folder when there is no Bambu Studio folder', async () => {
    const s = new DoctorService({
      config: {
        root: join(work, 'missing'),
        slicerRoots: { bambu: join(work, 'missing'), orca: orcaRoot },
        backupsDir: backups,
        testMode: false,
        fakeStudioRunning: null,
      },
      isStudioRunning: () => Promise.resolve(false),
      version: '9.9.9',
      donationUrl: '',
    });
    expect(ok(await s.getConfig())).toMatchObject({ root: orcaRoot, rootExists: true });
  });
});
