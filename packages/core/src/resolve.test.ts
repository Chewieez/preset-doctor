import { describe, expect, it } from 'vitest';
import type { PresetFs } from './fs.js';
import { nodeFs } from './node/nodeFs.js';
import {
  buildUserIndex,
  chain,
  resolveParent,
  type ResolveContext,
  type SystemPresetLike,
} from './resolve.js';
import { fixtureRoot } from './testing/fixtures.js';
import type { UserPreset } from './types.js';
import { scanUser } from './userScan.js';

// Stand-in for the system index: loads every BBL.json filament entry with its body.
async function loadSystem(fs: PresetFs): Promise<Map<string, SystemPresetLike>> {
  const index = JSON.parse(await fs.readText('system/BBL.json')) as {
    filament_list: { name: string; sub_path: string }[];
  };
  const map = new Map<string, SystemPresetLike>();
  for (const { name, sub_path } of index.filament_list) {
    const body = JSON.parse(await fs.readText(`system/BBL/${sub_path}`)) as Record<string, unknown>;
    map.set(name, { name, inherits: body['inherits'] as string | undefined });
  }
  return map;
}

async function fixtureContext(
  name: Parameters<typeof fixtureRoot>[0],
): Promise<{ ctx: ResolveContext; presets: UserPreset[] }> {
  const fs = nodeFs(fixtureRoot(name), { readOnly: true });
  const presets = await scanUser(fs, '1000000001');
  return { ctx: { system: await loadSystem(fs), userByName: buildUserIndex(presets) }, presets };
}

function userPreset(fileStem: string, json: Record<string, unknown>, isBase = false): UserPreset {
  const path = `user/1/filament/${isBase ? 'base/' : ''}${fileStem}.json`;
  return {
    accountId: '1',
    path,
    fileStem,
    isBase,
    raw: JSON.stringify(json),
    json,
    infoPath: path.replace(/\.json$/, '.info'),
  };
}

function ctxOf(system: SystemPresetLike[], users: UserPreset[]): ResolveContext {
  return {
    system: new Map(system.map((s) => [s.name, s])),
    userByName: buildUserIndex(users),
  };
}

describe('resolve on fixtures', () => {
  it('healthy: every preset chain ends at a root', async () => {
    const { ctx, presets } = await fixtureContext('healthy');
    for (const p of presets) {
      const c = chain(p, ctx);
      expect(c.end, p.path).toEqual({ kind: 'root' });
      if (!p.isBase) expect(c.links.length, p.path).toBeGreaterThan(1);
    }
  });

  it('healthy: wizard presets in base/ have no parent', async () => {
    const { ctx, presets } = await fixtureContext('healthy');
    for (const p of presets.filter((x) => x.isBase)) expect(chain(p, ctx).links).toEqual([]);
  });

  it('broken-r1: the 06 presets are orphans pointing at the missing 0.6 name', async () => {
    const { ctx, presets } = await fixtureContext('broken-r1');
    const orphans = presets.filter((p) => p.fileStem.endsWith(' 06'));
    expect(orphans).toHaveLength(18);
    for (const p of orphans) {
      const c = chain(p, ctx);
      expect(c.links).toEqual([]);
      expect(c.end.kind).toBe('missing');
      if (c.end.kind === 'missing') {
        expect(c.end.name).toMatch(/ @BBL X2D 0\.6 nozzle$/);
        expect(c.end.referencedBy).toBe(p.json?.['name']);
      }
    }
  });

  it('broken-r1: the user-parent case resolves through the user preset', async () => {
    const { ctx, presets } = await fixtureContext('broken-r1');
    const child = presets.find((p) => p.fileStem === 'Synthetic User Child')!;
    const c = chain(child, ctx);
    expect(c.end).toEqual({ kind: 'root' });
    expect(c.links[0]).toMatchObject({ kind: 'user', name: 'Anycubic Petg' });
    expect(c.links.slice(1).every((l) => l.kind === 'system')).toBe(true);
  });

  it('broken-r1: synthetic orphans are missing', async () => {
    const { ctx, presets } = await fixtureContext('broken-r1');
    for (const stem of [
      'Synthetic Stripped Suffix',
      'Synthetic Added Suffix',
      'Synthetic No Candidates',
    ]) {
      const p = presets.find((x) => x.fileStem === stem)!;
      expect(chain(p, ctx).end.kind, stem).toBe('missing');
    }
  });

  it('a system chain reaches the templates and stops at the root', async () => {
    const { ctx } = await fixtureContext('broken-r1');
    expect(resolveParent('Generic PETG @BBL X2D', ctx)?.kind).toBe('system');
    const leaf = userPreset('Leaf', { name: 'Leaf', inherits: 'Generic PETG @BBL X2D' });
    const c = chain(leaf, ctx);
    expect(c.end).toEqual({ kind: 'root' });
    expect(c.links.map((l) => l.name)).toContain('Generic PETG @base');
    expect(c.links.every((l) => l.kind === 'system')).toBe(true);
  });
});

describe('resolveParent', () => {
  const sys: SystemPresetLike = { name: 'Sys' };
  const user = userPreset('Mine', { name: 'Mine', inherits: 'Sys' });

  it('returns null for an empty name or a missing preset', () => {
    const ctx = ctxOf([sys], [user]);
    expect(resolveParent('', ctx)).toBeNull();
    expect(resolveParent('Nope', ctx)).toBeNull();
  });

  it('finds system and user presets, system first', () => {
    const shadow = userPreset('Sys', { name: 'Sys' });
    const ctx = ctxOf([sys], [user, shadow]);
    expect(resolveParent('Sys', ctx)).toEqual({ kind: 'system', name: 'Sys', entry: sys });
    expect(resolveParent('Mine', ctx)).toEqual({ kind: 'user', name: 'Mine', preset: user });
  });

  // Studio names a user preset after its file only (Preset.cpp:1455@v02.09.01.70).
  it('finds a user preset by file name only, not by a differing name field (R4)', () => {
    const odd = userPreset('test', { name: 'test.json' });
    const ctx = ctxOf([], [odd]);
    expect(resolveParent('test', ctx)?.kind).toBe('user');
    expect(resolveParent('test.json', ctx)).toBeNull();
  });

  it('keys by file name, even when another preset has that name field', () => {
    const a = userPreset('A', { name: 'B' });
    const b = userPreset('B', { name: 'Other' });
    const index = buildUserIndex([a, b]);
    expect(index.get('B')).toBe(b);
    expect(index.get('Other')).toBeUndefined();
    expect([...index.keys()]).toEqual(['A', 'B']);
  });

  it('reports a child of a name field that differs from the file name as orphaned', () => {
    const parent = userPreset('Parent file', { name: 'Parent', inherits: 'Sys' });
    const child = userPreset('Child', { name: 'Child', inherits: 'Parent' });
    const c = chain(child, ctxOf([sys], [parent, child]));
    expect(c.end).toEqual({ kind: 'missing', name: 'Parent', referencedBy: 'Child' });
  });

  it('does not call a preset a loop when it inherits its own name field from a system preset', () => {
    // File "Mine", name "Sys", inherits "Sys": Studio finds the system preset (no loop).
    const odd = userPreset('Mine', { name: 'Sys', inherits: 'Sys' });
    expect(chain(odd, ctxOf([sys], [odd])).end).toEqual({ kind: 'root' });
  });
});

describe('chain', () => {
  it('walks user -> user (base/) -> system', () => {
    const base = userPreset('Wizard', { name: 'Wizard', inherits: '' }, true);
    const child = userPreset('Child', { name: 'Child', inherits: 'Wizard' });
    const grand = userPreset('Grand', { name: 'Grand', inherits: 'Child' });
    const c = chain(grand, ctxOf([], [base, child, grand]));
    expect(c.links.map((l) => l.name)).toEqual(['Child', 'Wizard']);
    expect(c.end).toEqual({ kind: 'root' });
  });

  it('reports where the chain breaks', () => {
    const mid = userPreset('Mid', { name: 'Mid', inherits: 'Gone' });
    const leaf = userPreset('Leaf', { name: 'Leaf', inherits: 'Mid' });
    const c = chain(leaf, ctxOf([], [mid, leaf]));
    expect(c.links.map((l) => l.name)).toEqual(['Mid']);
    expect(c.end).toEqual({ kind: 'missing', name: 'Gone', referencedBy: 'Mid' });
  });

  it('guards against cycles, including self-inheritance', () => {
    const a = userPreset('A', { name: 'A', inherits: 'B' });
    const b = userPreset('B', { name: 'B', inherits: 'A' });
    expect(chain(a, ctxOf([], [a, b])).end).toEqual({ kind: 'cycle', name: 'A' });
    const self = userPreset('S', { name: 'S', inherits: 'S' });
    expect(chain(self, ctxOf([], [self])).end).toEqual({ kind: 'cycle', name: 'S' });
  });

  it('guards against cycles among system presets', () => {
    const leaf = userPreset('L', { name: 'L', inherits: 'X' });
    const ctx = ctxOf(
      [
        { name: 'X', inherits: 'Y' },
        { name: 'Y', inherits: 'X' },
      ],
      [leaf],
    );
    expect(chain(leaf, ctx).end).toEqual({ kind: 'cycle', name: 'X' });
  });

  it('stops very deep chains', () => {
    const system = Array.from({ length: 100 }, (_, i) => ({
      name: `S${i}`,
      inherits: `S${i + 1}`,
    }));
    const leaf = userPreset('L', { name: 'L', inherits: 'S0' });
    const c = chain(leaf, ctxOf(system, [leaf]));
    expect(c.end).toEqual({ kind: 'tooDeep' });
    expect(c.links).toHaveLength(64);
  });

  it('does not let a system preset inherit from a user preset', () => {
    const user = userPreset('U', { name: 'U' });
    const leaf = userPreset('L', { name: 'L', inherits: 'S' });
    const ctx = ctxOf([{ name: 'S', inherits: 'U' }], [user, leaf]);
    expect(chain(leaf, ctx).end).toEqual({
      kind: 'missing',
      name: 'U',
      referencedBy: 'S',
    });
  });

  it('treats a preset without parseable JSON as having no parent', () => {
    const broken: UserPreset = { ...userPreset('Bad', {}), raw: '{', parseError: 'x' };
    delete broken.json;
    expect(chain(broken, ctxOf([], [broken]))).toEqual({ links: [], end: { kind: 'root' } });
  });
});
