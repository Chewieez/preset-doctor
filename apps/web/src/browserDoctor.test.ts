import { fileURLToPath } from 'node:url';
import type { IpcResult } from '@preset-doctor/ui/contract';
import { unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { BACKUPS_DIR, BrowserDoctor, type BrowserDeps } from './browserDoctor';
import type { HandleStore } from './handleStore';
import { FakeDir, FakeFile, fakeFolder, fakeFolderFromDisk } from './testing/fakeHandle';
import { memoryHandleStore } from './testing/memoryHandleStore';

const FIXTURE = fileURLToPath(
  new URL('../../../packages/core/src/__fixtures__/broken-r1', import.meta.url),
);
const ORPHAN = 'user/1000000001/filament/Anycubic Petg 06.json';
const COPY = 'PresetDoctor-copy';

let copy: FakeDir;
let store: HandleStore;
let picks: (FakeDir | 'cancel')[];
let downloads: { name: string; data: Uint8Array }[];

function makeDoctor(extra: Partial<BrowserDeps> = {}): BrowserDoctor {
  return new BrowserDoctor({
    showDirectoryPicker: async () => {
      const next = picks.shift();
      if (next === undefined || next === 'cancel') {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
      }
      return next.handle;
    },
    handles: store,
    download: (name, data) => downloads.push({ name, data }),
    version: '9.9.9',
    now: () => new Date(2026, 10, 5, 17, 30, 0),
    ...extra,
  });
}

function ok<T>(r: IpcResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function error(r: IpcResult<unknown>): { code: string; message: string } {
  return r.ok ? { code: 'ok', message: '' } : r.error;
}

/** Picks the fake copy, like clicking "Choose folder" and choosing it. */
async function picked(d: BrowserDoctor, folder: FakeDir = copy): Promise<string> {
  picks.push(folder);
  const root = ok(await d.pickFolder());
  expect(root).not.toBeNull();
  return root!;
}

const zips = (): string[] => {
  const dir = copy.at(BACKUPS_DIR);
  return dir instanceof FakeDir ? [...dir.children.keys()].filter((n) => n.endsWith('.zip')) : [];
};

beforeEach(() => {
  copy = fakeFolderFromDisk(COPY, FIXTURE);
  store = memoryHandleStore();
  picks = [];
  downloads = [];
});

describe('BrowserDoctor', () => {
  it('reports a web config, with no folder until one is picked', async () => {
    const cfg = ok(await makeDoctor().getConfig());
    expect(cfg).toMatchObject({
      platform: 'web',
      root: '',
      rootExists: false,
      backupsDir: BACKUPS_DIR,
      version: '9.9.9',
      donationUrl: '',
      testMode: false,
    });
    expect(ok(await makeDoctor().studioStatus())).toBe('unknown');
  });

  it('remembers the picked folder for the next visit', async () => {
    await picked(makeDoctor());
    const later = makeDoctor();
    expect(ok(await later.getConfig())).toMatchObject({ root: COPY, rootExists: true });
    expect(error(await later.scan(COPY)).code).toBe('ok');
  });

  it('treats a cancelled picker as no change', async () => {
    const d = makeDoctor();
    picks.push('cancel');
    expect(ok(await d.pickFolder())).toBeNull();
    expect(ok(await d.getConfig()).root).toBe('');
  });

  it('scan -> plan -> apply -> rescan repairs the broken-r1 copy', async () => {
    const d = makeDoctor();
    const root = await picked(d);
    expect(root).toBe(COPY);

    const { result, defaults } = ok(await d.scan(root));
    expect(result.userId).toBe('1000000001');
    expect(result.presets.filter((p) => p.status === 'hidden')).toHaveLength(22);
    expect(defaults.find((c) => c.presetPath === ORPHAN)?.candidateName).toBe(
      'Generic PETG @BBL X2D',
    );
    // Scanning and planning never write.
    const plan = ok(await d.plan(defaults, { updateBaseId: true }));
    expect(copy.at(BACKUPS_DIR)).toBeUndefined();
    expect(plan.changes.find((c) => c.path === ORPHAN)?.diff).toContain(
      '+    "inherits": "Generic PETG @BBL X2D",',
    );

    const applied = ok(await d.apply(plan.planId));
    expect(applied.backupIsNew).toBe(true);
    expect(applied.written).toContain(ORPHAN);
    expect(applied.written.every((p) => p.startsWith('user/1000000001/'))).toBe(true);
    expect(copy.text(ORPHAN)).toContain('"inherits": "Generic PETG @BBL X2D",');

    // The backup sits next to the copy and holds the untouched user folder.
    expect(zips()).toEqual([`${applied.backup.id}.zip`]);
    const zipFile = copy.at(`${BACKUPS_DIR}/${applied.backup.id}.zip`);
    const entries = unzipSync((zipFile as { data: Uint8Array }).data);
    const original = fakeFolderFromDisk('o', FIXTURE).text(ORPHAN);
    expect(new TextDecoder().decode(entries[ORPHAN])).toBe(original);

    const rescan = ok(await d.scan(root));
    const hidden = rescan.result.presets.filter((p) => p.status === 'hidden');
    // Left alone: no candidates at all, one with only unlikely ones, and one whose nozzle size
    // is unsure (neither is ever pre-selected).
    expect(hidden.map((p) => p.name).sort()).toEqual([
      'Synthetic No Candidates',
      'Synthetic Other Printer Only',
      'Synthetic Stripped Suffix',
    ]);
    expect(rescan.result.presets.filter((p) => p.status === 'broken')).toHaveLength(0);
  });

  it('backs up before every repair, since the copy may be refreshed in between', async () => {
    const d = makeDoctor();
    const root = await picked(d);
    const { defaults } = ok(await d.scan(root));
    const first = ok(await d.plan(defaults.slice(0, 1), { updateBaseId: true }));
    const second = ok(await d.plan(defaults.slice(1), { updateBaseId: true }));

    const a = ok(await d.apply(first.planId));
    expect(a.backupIsNew).toBe(true);
    expect(error(await d.apply(second.planId)).code).toBe('invalid');

    const rescan = ok(await d.scan(root));
    const b = ok(await d.apply(ok(await d.plan(rescan.defaults, { updateBaseId: true })).planId));
    expect(b.backupIsNew).toBe(true);
    expect(b.backup.id).not.toBe(a.backup.id);
    expect(zips()).toHaveLength(2);
  });

  it('refuses a stale plan without writing anything', async () => {
    const d = makeDoctor();
    const root = await picked(d);
    const { defaults } = ok(await d.scan(root));
    const { planId } = ok(await d.plan(defaults, { updateBaseId: true }));
    copy.put(ORPHAN, `${copy.text(ORPHAN)!} `);
    const other = defaults.find((c) => c.presetPath !== ORPHAN)!.presetPath;
    const otherBefore = copy.text(other);

    expect(error(await d.apply(planId)).code).toBe('stale');
    expect(copy.text(other)).toBe(otherBefore);
  });

  it('refuses a plan whose file was deleted since, before making a backup', async () => {
    const d = makeDoctor();
    const root = await picked(d);
    const { defaults } = ok(await d.scan(root));
    const { planId } = ok(await d.plan(defaults, { updateBaseId: true }));
    const name = ORPHAN.slice(ORPHAN.lastIndexOf('/') + 1);
    copy.dir('user/1000000001/filament').children.delete(name);
    const other = defaults.find((c) => c.presetPath !== ORPHAN)!.presetPath;
    const otherBefore = copy.text(other);

    // Stale (scan again), not "the backup doesn't include it".
    expect(error(await d.apply(planId)).code).toBe('stale');
    expect(copy.text(other)).toBe(otherBefore);
    expect(zips()).toEqual([]);
  });

  it('refuses to write what the backup does not hold', async () => {
    const d = makeDoctor();
    const root = await picked(d);
    const { defaults } = ok(await d.scan(root));
    const { planId } = ok(await d.plan(defaults, { updateBaseId: true }));
    // The backup's listing misses ORPHAN, while it can still be read and written by name.
    const name = ORPHAN.slice(ORPHAN.lastIndexOf('/') + 1);
    copy.dir('user/1000000001/filament').hidden.add(name);
    const orphanBefore = copy.text(ORPHAN);
    const other = defaults.find((c) => c.presetPath !== ORPHAN)!.presetPath;
    const otherBefore = copy.text(other);

    const e = error(await d.apply(planId));
    expect(e.code).toBe('failed');
    expect(e.message).toContain(name);
    expect(e.message).toContain('Move those files back');
    expect(copy.text(ORPHAN)).toBe(orphanBefore);
    expect(copy.text(other)).toBe(otherBefore);
  });

  it('reports a thrown non-Error as a failure with its text', async () => {
    const d = makeDoctor({
      download: () => {
        throw 'boom';
      },
    });
    const root = await picked(d);
    const { defaults } = ok(await d.scan(root));
    const applied = ok(await d.apply(ok(await d.plan(defaults, { updateBaseId: true })).planId));
    expect(await d.downloadBackup(applied.backup.id)).toEqual({
      ok: false,
      error: { code: 'failed', message: 'boom' },
    });
  });

  it('validates choices and the folder it is given', async () => {
    const d = makeDoctor();
    expect(error(await d.plan([], { updateBaseId: true })).code).toBe('invalid');
    expect(error(await d.scan(COPY)).code).toBe('invalid');
    const root = await picked(d);
    expect(error(await d.scan('Other folder')).code).toBe('invalid');
    ok(await d.scan(root));
    expect(
      error(
        await d.plan([{ presetPath: ORPHAN, candidateName: 'Made Up' }], { updateBaseId: true }),
      ).code,
    ).toBe('invalid');
    expect(error(await d.apply('nope')).code).toBe('invalid');
  });

  it('explains what to copy when the folder is incomplete', async () => {
    const d = makeDoctor();
    const cases: [FakeDir, RegExp][] = [
      [fakeFolder('Empty'), /Copy the "system" and "user" folders/],
      [fakeFolder('user', { '1000000001/filament/a.json': '{}' }), /picked the "user" folder/],
      [fakeFolder('NoSystem', { 'user/1000000001/filament/a.json': '{}' }), /system\\BBL\.json/],
      [fakeFolder('NoUser', { 'system/BBL.json': '{}' }), /no "user" folder/],
    ];
    for (const [folder, message] of cases) {
      const root = await picked(d, folder);
      const e = error(await d.scan(root));
      expect(e.code).toBe('scan-failed');
      expect(e.message).toMatch(message);
    }
  });

  it('warns when BambuStudio.conf was not copied', async () => {
    copy.children.delete('BambuStudio.conf');
    const d = makeDoctor();
    const { result } = ok(await d.scan(await picked(d)));
    expect(result.warnings.join(' ')).toMatch(/BambuStudio\.conf wasn't copied/);
  });

  it('uses a BambuStudio folder copied whole into the picked folder', async () => {
    const outer = fakeFolder('Documents');
    outer.children.set('BambuStudio', fakeFolderFromDisk('BambuStudio', FIXTURE));
    const d = makeDoctor();
    const root = await picked(d, outer);
    expect(root).toBe('BambuStudio');
    expect(error(await d.scan(root)).code).toBe('ok');
  });

  it('asks for write permission on scan and stops if it is refused', async () => {
    copy.permission = 'denied';
    const d = makeDoctor();
    const e = error(await d.scan(await picked(d)));
    expect(e.code).toBe('scan-failed');
    expect(e.message).toMatch(/needs permission/);
    expect(copy.requests).toBe(1);
  });

  it('restores a backup and offers it as a download', async () => {
    const d = makeDoctor();
    const root = await picked(d);
    const original = copy.text(ORPHAN);
    expect(ok(await d.listBackups())).toEqual([]);
    const { defaults } = ok(await d.scan(root));
    const applied = ok(await d.apply(ok(await d.plan(defaults, { updateBaseId: true })).planId));
    expect(copy.text(ORPHAN)).not.toBe(original);

    ok(await d.downloadBackup(applied.backup.id));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.name).toBe(`preset-doctor-backup-${applied.backup.id}.zip`);
    expect(downloads[0]!.data.length).toBe(applied.backup.bytes);
    expect(error(await d.downloadBackup('../../x')).code).toBe('invalid');

    expect(error(await d.restore(root, '../../etc')).code).toBe('invalid');
    expect(error(await d.restore('Other folder', applied.backup.id)).code).toBe('invalid');
    expect(ok(await d.listBackups())[0]?.sourceRoot).toBe(COPY);
    const restored = ok(await d.restore(root, applied.backup.id));
    expect(restored.restoredCount).toBeGreaterThan(0);
    expect(restored.safetyBackup).not.toBeNull();
    expect(copy.text(ORPHAN)).toBe(original);
    expect(ok(await d.listBackups())).toHaveLength(2);
  });

  it('asks for permission again before listing or downloading backups after a reload', async () => {
    const first = makeDoctor();
    const root = await picked(first);
    const { defaults } = ok(await first.scan(root));
    const applied = ok(
      await first.apply(ok(await first.plan(defaults, { updateBaseId: true })).planId),
    );

    // A new page load: the remembered folder is back to "ask", and the user says no.
    copy.permission = 'prompt';
    const d = makeDoctor();
    const requests = copy.requests;
    for (const r of [await d.listBackups(), await d.downloadBackup(applied.backup.id)]) {
      expect(error(r)).toEqual({
        code: 'invalid',
        message: `Preset Doctor needs permission to open "${COPY}". Click Scan and choose Allow, then try again.`,
      });
    }
    expect(copy.requests).toBe(requests + 2);
    expect(downloads).toEqual([]);

    copy.permission = 'granted';
    expect(ok(await d.listBackups())).toHaveLength(1);
  });

  it('backs up again after a stale repair, even when the same folder is picked again', async () => {
    const d = makeDoctor();
    const root = await picked(d);
    const { defaults } = ok(await d.scan(root));
    const { planId } = ok(await d.plan(defaults, { updateBaseId: true }));
    copy.put(ORPHAN, `${copy.text(ORPHAN)!} `);
    expect(error(await d.apply(planId)).code).toBe('stale');
    const staleZips = zips();

    // The same folder again, as a new handle object (isSameEntry is true for real handles).
    const again = Object.create(copy) as FakeDir;
    const same = async (other: unknown): Promise<boolean> => other === copy || other === again;
    copy.isSameEntry = same;
    again.isSameEntry = same;
    await picked(d, again);
    const rescan = ok(await d.scan(root));
    const applied = ok(
      await d.apply(ok(await d.plan(rescan.defaults, { updateBaseId: true })).planId),
    );
    expect(applied.backupIsNew).toBe(true);
    expect(staleZips).not.toContain(`${applied.backup.id}.zip`);
    // The new backup holds the folder as it was just before this repair.
    const zip = copy.at(`${BACKUPS_DIR}/${applied.backup.id}.zip`) as { data: Uint8Array };
    expect(new TextDecoder().decode(unzipSync(zip.data)[ORPHAN])).toMatch(/ $/);
  });

  it('says to choose the folder again when it was deleted after picking', async () => {
    const d = makeDoctor();
    const root = await picked(d);
    const gone = (): never => {
      const err = new Error('A requested file or directory could not be found.');
      err.name = 'NotFoundError';
      throw err;
    };
    copy.getDirectoryHandle = async () => gone();
    copy.getFileHandle = async () => gone();
    copy.values = async function* () {
      yield* [];
      gone();
    };
    const e = error(await d.scan(root));
    expect(e.code).toBe('scan-failed');
    expect(e.message).toMatch(/can't be read anymore.*choose it again/);
  });

  it('reports a restore that stops part-way, naming the backup that undoes it', async () => {
    const d = makeDoctor();
    const root = await picked(d);
    const { defaults } = ok(await d.scan(root));
    const applied = ok(await d.apply(ok(await d.plan(defaults, { updateBaseId: true })).planId));

    // The browser takes the permission away while the restore is writing.
    let writes = 0;
    const real = FakeFile.prototype.createWritable;
    FakeFile.prototype.createWritable = async function (this: FakeFile) {
      if (this.name.endsWith('.json') && ++writes === 3) {
        const err = new Error('Permission revoked');
        err.name = 'NotAllowedError';
        throw err;
      }
      return real.call(this);
    };
    let r: IpcResult<unknown>;
    try {
      r = await d.restore(root, applied.backup.id);
    } finally {
      FakeFile.prototype.createWritable = real;
    }
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('partial');
    expect(r.error.message).toContain('The restore stopped part-way at');
    expect(r.error.backupId).toBe(`${applied.backup.id}-2`);
    expect(r.error.message).toContain(`restore backup ${applied.backup.id}-2`);
    expect(r.error.written).toHaveLength(2);
    expect(zips()).toContain(`${applied.backup.id}-2.zip`);
  });

  it('cannot open File Explorer or a donation page', async () => {
    const d = makeDoctor();
    expect(error(await d.openBackupsFolder()).message).toMatch(/preset-doctor-backups/);
    expect(error(await d.openDonationPage()).code).toBe('invalid');
  });

  it('says so when the browser has no folder picker', async () => {
    const d = new BrowserDoctor({
      showDirectoryPicker: undefined,
      handles: store,
      download: () => undefined,
      version: '1',
    });
    expect(error(await d.pickFolder()).message).toMatch(/Chrome or Edge/);
  });
});

describe('BrowserDoctor with an OrcaSlicer copy', () => {
  const ORCA_FIXTURE = fileURLToPath(
    new URL('../../../packages/core/src/__fixtures__/orca', import.meta.url),
  );

  it('scans it as OrcaSlicer, and tags its backups', async () => {
    const orca = fakeFolderFromDisk(COPY, ORCA_FIXTURE);
    const d = makeDoctor();
    const root = await picked(d, orca);
    const { result, defaults } = ok(await d.scan(root));
    expect(result.slicer).toBe('orca');
    const { planId } = ok(await d.plan(defaults, { updateBaseId: true }));
    const applied = ok(await d.apply(planId));
    expect(applied.backup.slicer).toBe('orca');
    const restored = ok(await d.restore(root, applied.backup.id));
    expect(restored.skipped).toEqual(['user/default/filament/Lone.info']);
  });

  it('uses an OrcaSlicer folder copied whole into the picked folder', async () => {
    const outer = fakeFolder('Documents');
    outer.children.set('OrcaSlicer', fakeFolderFromDisk('OrcaSlicer', ORCA_FIXTURE));
    const d = makeDoctor();
    const root = await picked(d, outer);
    expect(root).toBe('OrcaSlicer');
    expect(ok(await d.scan(root)).result.slicer).toBe('orca');
  });

  it('names OrcaSlicer files in what to copy', async () => {
    const d = makeDoctor();
    const cases: [FakeDir, RegExp][] = [
      [
        fakeFolder('NoSystem', {
          'OrcaSlicer.conf': '{}',
          'user/default/filament/a.json': '{}',
        }),
        /has no system presets .*%APPDATA%\\OrcaSlicer/,
      ],
      [
        fakeFolder('NoUser', { 'system/OrcaFilamentLibrary.json': '{}' }),
        /no "user" folder\. Copy the "user" folder from %APPDATA%\\OrcaSlicer/,
      ],
      [
        fakeFolder('Both', { 'BambuStudio.conf': '{}', 'OrcaSlicer.conf': '{}' }),
        /both Bambu Studio and OrcaSlicer/,
      ],
    ];
    for (const [folder, message] of cases) {
      const root = await picked(d, folder);
      const e = error(await d.scan(root));
      expect(e.code).toBe('scan-failed');
      expect(e.message).toMatch(message);
    }
  });

  it('warns when OrcaSlicer.conf was not copied, naming OrcaSlicer', async () => {
    const orca = fakeFolderFromDisk(COPY, ORCA_FIXTURE);
    orca.children.delete('OrcaSlicer.conf');
    const d = makeDoctor();
    const { result } = ok(await d.scan(await picked(d, orca)));
    expect(result.warnings.join(' ')).toMatch(
      /OrcaSlicer\.conf wasn't copied.*save the preset in OrcaSlicer\./,
    );
  });

  it('refuses a Bambu Studio backup in an OrcaSlicer copy', async () => {
    const d = makeDoctor();
    const bambuRoot = await picked(d);
    const s = ok(await d.scan(bambuRoot));
    const applied = ok(await d.apply(ok(await d.plan(s.defaults, { updateBaseId: true })).planId));
    // The same folder, now holding OrcaSlicer's files.
    copy.children.delete('BambuStudio.conf');
    const conf = new FakeFile('OrcaSlicer.conf');
    conf.data = new TextEncoder().encode('{}');
    copy.children.set('OrcaSlicer.conf', conf);
    expect(error(await d.restore(bambuRoot, applied.backup.id)).code).toBe('other-slicer');
  });
});
