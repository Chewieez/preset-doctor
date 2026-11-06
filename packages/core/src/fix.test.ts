import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ApplyError,
  applyChanges,
  defaultChoices,
  FixError,
  planFixes,
  StaleChangeError,
  unifiedDiff,
} from './fix.js';
import type { PresetFs } from './fs.js';
import { memFs } from './memFs.js';
import { nodeFs } from './node/nodeFs.js';
import { R1_ID } from './rules/r1.js';
import { scan } from './scan.js';
import { fixtureRoot } from './testing/fixtures.js';
import { fakeStudio, sidecar, tempFixture } from './testing/studio.js';
import type { Change } from './types.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function temp(name: Parameters<typeof tempFixture>[0]): string {
  const t = tempFixture(name);
  cleanups.push(t.cleanup);
  return t.dir;
}

/** Lines that differ between two texts of equal line count. */
function changedLines(a: string, b: string): [string, string][] {
  const la = a.split('\n');
  const lb = b.split('\n');
  expect(la.length).toBe(lb.length);
  return la.flatMap((l, i) => (l === lb[i] ? [] : [[l, lb[i]!] as [string, string]]));
}

describe('planFixes', () => {
  it('broken-r1: one-line inherits edits plus base_id where a sidecar exists', async () => {
    const fs = nodeFs(fixtureRoot('broken-r1'), { readOnly: true });
    const r = await scan(fs);
    const choices = defaultChoices(r);
    expect(choices).toHaveLength(20);
    const changes = await planFixes(fs, r, choices);

    const json = changes.filter((c) => c.path.endsWith('.json'));
    const info = changes.filter((c) => c.path.endsWith('.info'));
    expect(json).toHaveLength(20);
    for (const c of json) expect(changedLines(c.before, c.after)).toHaveLength(1);

    const petg = json.find((c) => c.path.endsWith('/Anycubic Petg 06.json'))!;
    expect(changedLines(petg.before, petg.after)).toEqual([
      [
        '    "inherits": "Generic PETG @BBL X2D 0.6 nozzle",',
        '    "inherits": "Generic PETG @BBL X2D",',
      ],
    ]);
    expect(petg.description).toBe(
      'Set its parent to "Generic PETG @BBL X2D" (was "Generic PETG @BBL X2D 0.6 nozzle").',
    );

    // Only the two synthetic presets with a pre-selected fix have sidecars.
    expect(info.map((c) => c.path.slice(c.path.lastIndexOf('/') + 1))).toEqual([
      'Synthetic Added Suffix.info',
      'Synthetic Stripped Suffix.info',
    ]);
    const added = info[0]!;
    expect(changedLines(added.before, added.after)).toEqual([
      ['base_id = GFSG99_15\r', 'base_id = GFSB00\r'],
    ]);
  });

  it('leaves sidecars alone with updateBaseId: false', async () => {
    const fs = nodeFs(fixtureRoot('broken-r1'), { readOnly: true });
    const r = await scan(fs);
    const changes = await planFixes(fs, r, defaultChoices(r), { updateBaseId: false });
    expect(changes.every((c) => c.path.endsWith('.json'))).toBe(true);
  });

  it('broken-r4: nothing to rename, since Studio itself saved "test.json" as test.json', async () => {
    const fs = nodeFs(fixtureRoot('broken-r4'), { readOnly: true });
    const r = await scan(fs);
    expect(defaultChoices(r)).toEqual([]);
  });

  it('renames a real name/file mismatch, keeping CRLF and filament_settings_id in step', async () => {
    // The broken-r4 test.json (CRLF, name "test.json") under another file name.
    const dir = temp('broken-r4');
    const folder = join(dir, 'user', '1000000001', 'filament');
    renameSync(join(folder, 'test.json'), join(folder, 'Old copy.json'));
    renameSync(join(folder, 'test.info'), join(folder, 'Old copy.info'));
    const fs = nodeFs(dir, { readOnly: true });
    const r = await scan(fs);
    const [change, ...more] = await planFixes(fs, r, defaultChoices(r));
    expect(more).toEqual([]);
    expect(change?.path).toBe('user/1000000001/filament/Old copy.json');
    expect(change?.before).toContain('\r\n');
    expect(changedLines(change!.before, change!.after)).toEqual([
      ['        "test.json"\r', '        "Old copy"\r'],
      ['    "name": "test.json",\r', '    "name": "Old copy",\r'],
    ]);
  });

  it('never re-parents an orphan onto a preset that the same repair renames', async () => {
    const fs = fakeStudio(
      [{ name: 'Generic PLA @BBL X1C', compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'] }],
      [
        {
          file: 'My PLA @BBL X1C (2)',
          name: 'My PLA @BBL X1C',
          inherits: 'Generic PLA @BBL X1C',
          info: sidecar('GFL99'),
        },
        { name: 'Child', inherits: 'My PLA @BBL X1C 0.4 nozzle', info: sidecar('GFL99') },
      ],
    );
    const parentPath = 'user/1000000001/filament/My PLA @BBL X1C (2).json';
    const childPath = 'user/1000000001/filament/Child.json';
    const r = await scan(fs);
    // The default repair re-parents Child and leaves its new parent's name alone...
    expect(defaultChoices(r)).toEqual([
      { presetPath: childPath, candidateName: 'My PLA @BBL X1C' },
    ]);
    await applyChanges(fs, await planFixes(fs, r, defaultChoices(r)));
    const after = await scan(fs);
    expect(after.presets.filter((p) => p.status === 'hidden')).toEqual([]);

    // ...and a hand-made selection that does both is refused.
    await expect(
      planFixes(fs, r, [
        { presetPath: childPath, candidateName: 'My PLA @BBL X1C' },
        { presetPath: parentPath, rename: true },
      ]),
    ).rejects.toThrow(
      '"My PLA @BBL X1C" is renamed in the same repair, so it can\'t also be the new parent of "Child"',
    );
  });

  it('refuses to edit a file that is not valid UTF-8, which would rewrite its bad bytes', async () => {
    const fs = fakeStudio(
      [{ name: 'Generic PLA @BBL X2D', compatible_printers: ['Bambu Lab X2D 0.6 nozzle'] }],
      [{ name: 'Mine', inherits: 'Generic PLA @BBL X2D 0.6 nozzle', info: sidecar('x') }],
    );
    const path = 'user/1000000001/filament/Mine.json';
    const r = await scan(fs);
    // Saved as ANSI after the scan: "215 °C" with a raw 0xB0 byte.
    const text = (await fs.readText(path)).replace(
      '"from"',
      '"filament_notes": "215 \u0000C", "from"',
    );
    const bytes = new TextEncoder().encode(text);
    bytes[bytes.indexOf(0)] = 0xb0;
    await fs.writeBytes(path, bytes);
    await expect(
      planFixes(fs, r, [{ presetPath: path, candidateName: 'Generic PLA @BBL X2D' }]),
    ).rejects.toThrow('is not valid UTF-8 text');
    // A fresh scan reports the file as damaged instead, with nothing to plan.
    const again = await scan(fs);
    expect(again.findings.map((f) => f.title)).toEqual(['File is damaged']);
    expect(again.findings[0]?.explanation).toContain('not valid UTF-8 text');
    expect(Array.from(await fs.readBytes(path))).toEqual(Array.from(bytes));
  });

  it('accepts any listed candidate, and combines edits to one file', async () => {
    const fs = fakeStudio(
      [
        { name: 'Generic PLA @BBL X2D', compatible_printers: ['Bambu Lab X2D 0.6 nozzle'] },
        {
          name: 'Generic PLA @BBL X2D 0.4 nozzle',
          compatible_printers: ['Bambu Lab X2D 0.4 nozzle'],
        },
      ],
      [
        {
          file: 'Mine',
          name: 'Mine old',
          inherits: 'Generic PLA @BBL X2D 0.6 nozzle',
          info: sidecar('OLD'),
        },
      ],
    );
    const r = await scan(fs);
    const path = 'user/1000000001/filament/Mine.json';
    const changes = await planFixes(fs, r, [
      { presetPath: path, candidateName: 'Generic PLA @BBL X2D 0.4 nozzle' },
      { presetPath: path, rename: true },
    ]);
    expect(changes.map((c) => c.path)).toEqual([path]);
    const after = JSON.parse(changes[0]!.after) as Record<string, unknown>;
    expect(after).toMatchObject({
      name: 'Mine',
      inherits: 'Generic PLA @BBL X2D 0.4 nozzle',
      filament_settings_id: ['Mine'],
    });
    // No setting_id on the fake system preset, so base_id stays.
    expect(changes[0]!.description).toBe(
      'Set its parent to "Generic PLA @BBL X2D 0.4 nozzle" (was "Generic PLA @BBL X2D 0.6 nozzle") and rename it from "Mine old" to "Mine".',
    );
  });

  it('refuses choices that do not match the scan', async () => {
    const fs = nodeFs(fixtureRoot('broken-r1'), { readOnly: true });
    const r = await scan(fs);
    const path = 'user/1000000001/filament/Anycubic Petg 06.json';
    await expect(planFixes(fs, r, [{ presetPath: path, candidateName: 'Nope' }])).rejects.toThrow(
      FixError,
    );
    await expect(planFixes(fs, r, [{ presetPath: path, rename: true }])).rejects.toThrow(
      'There is no rename',
    );
    await expect(planFixes(fs, r, [{ presetPath: 'user/x.json' }])).rejects.toThrow(
      'was not part of this scan',
    );
  });

  it('refuses to plan when the file changed after the scan', async () => {
    const fs = fakeStudio(
      [{ name: 'Generic PLA @BBL X2D', compatible_printers: ['Bambu Lab X2D 0.6 nozzle'] }],
      [{ name: 'Mine', inherits: 'Generic PLA @BBL X2D 0.6 nozzle' }],
    );
    const r = await scan(fs);
    const path = 'user/1000000001/filament/Mine.json';
    const text = await fs.readText(path);
    await fs.writeText(path, text.replace('X2D 0.6 nozzle', 'X2D 0.8 nozzle'));
    const err = await planFixes(fs, r, defaultChoices(r)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FixError);
    expect((err as FixError).stale).toBe(true);
  });
});

describe('applyChanges', () => {
  it('fixes broken-r1 on a temp copy; a rescan finds only the presets without a sure fix', async () => {
    const dir = temp('broken-r1');
    const fs = nodeFs(dir);
    const r = await scan(fs);
    const changes = await planFixes(fs, r, defaultChoices(r));
    const { written } = await applyChanges(fs, changes);
    expect(written).toHaveLength(22);

    const again = await scan(fs);
    const left = again.findings.filter((f) => f.ruleId === R1_ID).map((f) => f.presetName);
    expect(left).toEqual(['Synthetic No Candidates', 'Synthetic Other Printer Only']);
    expect(
      readFileSync(join(dir, 'user/1000000001/filament/Synthetic Stripped Suffix.info'), 'utf8'),
    ).toBe(
      'sync_info = \r\nuser_id = 1000000001\r\nsetting_id = PFUSc12a29cdb2a4af\r\n' +
        'base_id = GFSA00_08\r\nupdated_time = 1782278409\r\n',
    );

    // Choosing the low-confidence candidate by hand fixes the last fixable one.
    const other = again.findings.find((f) => f.presetName === 'Synthetic Other Printer Only')!;
    const pick =
      other.proposedFix?.kind === 'setInherits' ? other.proposedFix.candidates[0] : undefined;
    await applyChanges(
      fs,
      await planFixes(fs, again, [{ presetPath: other.presetPath, candidateName: pick!.name }]),
    );
    const last = (await scan(fs)).findings.filter((f) => f.ruleId === R1_ID);
    expect(last.map((f) => f.presetName)).toEqual(['Synthetic No Candidates']);
  });

  it('writes nothing if any file changed since planning', async () => {
    const dir = temp('broken-r1');
    const fs = nodeFs(dir);
    const r = await scan(fs);
    const changes = await planFixes(fs, r, defaultChoices(r));
    const victim = join(dir, 'user/1000000001/filament/Inland Petg 06.json');
    writeFileSync(victim, readFileSync(victim, 'utf8') + ' ');

    const err = await applyChanges(fs, changes).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleChangeError);
    expect((err as StaleChangeError).paths).toEqual([
      'user/1000000001/filament/Inland Petg 06.json',
    ]);
    for (const c of changes) {
      if (c.path.endsWith('Inland Petg 06.json')) continue;
      expect(await fs.readText(c.path)).toBe(c.before);
    }
  });

  it('refuses duplicate paths and reports writes that do not read back', async () => {
    const fs = memFs({ 'a.json': '{}' });
    const change: Change = { path: 'a.json', before: '{}', after: '{ }', description: '' };
    await expect(applyChanges(fs, [change, change])).rejects.toThrow('More than one change');

    const liar: PresetFs = { ...fs, writeText: async () => {} };
    const err = await applyChanges(liar, [change]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplyError);
    expect((err as ApplyError).written).toEqual([]);
  });

  it('lists a file as written when the write landed but reading it back failed', async () => {
    const fs = memFs({ 'a.json': '{}', 'b.json': '{}' });
    const changes: Change[] = ['a.json', 'b.json'].map((path) => ({
      path,
      before: '{}',
      after: '{ }',
      description: '',
    }));
    // Like an antivirus scanner locking b.json right after it was replaced.
    let locked = false;
    const flaky: PresetFs = {
      ...fs,
      writeText: async (path, data) => {
        await fs.writeText(path, data);
        if (path === 'b.json') locked = true;
      },
      readBytes: async (path) => {
        if (locked && path === 'b.json') {
          locked = false;
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        }
        return fs.readBytes(path);
      },
    };
    const err = await applyChanges(flaky, changes).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplyError);
    expect((err as ApplyError).message).toContain('EBUSY');
    expect((err as ApplyError).written).toEqual(['a.json', 'b.json']);
    expect(fs.snapshot()).toEqual({ 'a.json': '{ }', 'b.json': '{ }' });
  });

  it('refuses to write through a read-only adapter', async () => {
    const fs = nodeFs(fixtureRoot('broken-r1'), { readOnly: true });
    const r = await scan(fs);
    const changes = await planFixes(fs, r, defaultChoices(r));
    await expect(applyChanges(fs, changes)).rejects.toThrow(ApplyError);
  });
});

describe('unifiedDiff', () => {
  const change = (before: string, after: string): Change => ({
    path: 'p.json',
    before,
    after,
    description: '',
  });
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`);

  it('shows a one-line change with three lines of context', () => {
    const a = lines(10);
    const b = [...a];
    b[4] = 'L5';
    expect(unifiedDiff(change(a.join('\n'), b.join('\n')))).toBe(
      [
        '--- a/p.json',
        '+++ b/p.json',
        '@@ -2,7 +2,7 @@',
        ' l2',
        ' l3',
        ' l4',
        '-l5',
        '+L5',
        ' l6',
        ' l7',
        ' l8',
      ].join('\n'),
    );
  });

  it('splits distant changes into separate hunks and merges close ones', () => {
    const a = lines(30);
    const far = [...a];
    far[1] = 'X';
    far[25] = 'Y';
    expect(unifiedDiff(change(a.join('\n'), far.join('\n'))).match(/^@@/gm)).toHaveLength(2);
    const near = [...a];
    near[1] = 'X';
    near[6] = 'Y';
    expect(unifiedDiff(change(a.join('\n'), near.join('\n'))).match(/^@@/gm)).toHaveLength(1);
  });

  it('handles insertions, deletions and CRLF', () => {
    expect(unifiedDiff(change('a\r\nb\r\n', 'a\r\nb\r\nc\r\n'))).toBe(
      '--- a/p.json\n+++ b/p.json\n@@ -1,2 +1,3 @@\n a\n b\n+c',
    );
    expect(unifiedDiff(change('a\nb', 'b'))).toBe(
      '--- a/p.json\n+++ b/p.json\n@@ -1,2 +1,1 @@\n-a\n b',
    );
    expect(unifiedDiff(change('', 'x'))).toBe('--- a/p.json\n+++ b/p.json\n@@ -0,0 +1,1 @@\n+x');
    expect(unifiedDiff(change('same', 'same'))).toBe('--- a/p.json\n+++ b/p.json');
  });
});
