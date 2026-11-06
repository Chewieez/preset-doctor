import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSrc = (p: string): string =>
  fileURLToPath(new URL(`./packages/core/src/${p}`, import.meta.url));

// `npm run test:live` (vitest --mode live) also runs the read-only checks against the real
// Bambu Studio folder. A mode rather than an env var, so the command works in every shell.
export default defineConfig(({ mode }) => ({
  // Apps import core by package name; test them against core's source, not a possibly stale dist.
  resolve: {
    alias: [
      { find: /^@preset-doctor\/core\/node$/, replacement: coreSrc('node/index.ts') },
      { find: /^@preset-doctor\/core$/, replacement: coreSrc('index.ts') },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    env: mode === 'live' ? { PRESET_DOCTOR_LIVE: '1' } : {},
  },
}));
