import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSrc = (p: string): string =>
  fileURLToPath(new URL(`./packages/core/src/${p}`, import.meta.url));

export default defineConfig({
  // Apps import core by package name; test them against core's source, not a possibly stale dist.
  resolve: {
    alias: [
      { find: /^@preset-doctor\/core\/node$/, replacement: coreSrc('node/index.ts') },
      { find: /^@preset-doctor\/core$/, replacement: coreSrc('index.ts') },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
  },
});
