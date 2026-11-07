// Test-only helpers (excluded from the build). Node-only.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = fileURLToPath(new URL('../__fixtures__', import.meta.url));

export const FIXTURE_NAMES = [
  'healthy',
  'broken-r1',
  'broken-r4',
  'multi-account',
  'types-bambu',
  'unsupported-bambu',
] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

/** OrcaSlicer fixtures (scripts/make-orca-fixture.ts); FIXTURE_NAMES are the Bambu Studio ones. */
export const ORCA_FIXTURE_NAMES = ['orca'] as const;
export type OrcaFixtureName = (typeof ORCA_FIXTURE_NAMES)[number];

export function fixtureRoot(name: FixtureName | OrcaFixtureName): string {
  return join(FIXTURES_DIR, name);
}

/** Every fixture file with the given extension, as '/'-joined paths relative to FIXTURES_DIR. */
export function fixtureFiles(ext: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) out.push(relative(FIXTURES_DIR, p).split('\\').join('/'));
    }
  };
  walk(FIXTURES_DIR);
  return out.sort();
}

/** Reads a fixture file exactly as stored (BOM kept). */
export function readFixture(rel: string): string {
  return readFileSync(join(FIXTURES_DIR, ...rel.split('/'))).toString('utf8');
}
