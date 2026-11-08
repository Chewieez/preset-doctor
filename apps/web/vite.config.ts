import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type PluginOption } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// Bundle core from source, so the site never ships a stale packages/core/dist.
const coreIndex = fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url));

/** Core's node entry uses node:fs; a browser build must never pull it in. */
function noNodeCore(): PluginOption {
  return {
    name: 'preset-doctor-no-node-core',
    enforce: 'pre',
    resolveId(id) {
      if (id === '@preset-doctor/core/node' || id.startsWith('node:')) {
        throw new Error(`The web build must not import "${id}" (Node-only).`);
      }
      return null;
    },
  };
}

/** The dev server needs inline scripts and a websocket for hot reload; the build stays strict. */
function devCsp(): PluginOption {
  return {
    name: 'preset-doctor-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"/,
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; ` +
          `script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; ` +
          `img-src 'self' data:; connect-src 'self' ws://localhost:*"`,
      );
    },
  };
}

export default defineConfig({
  root: here,
  // GitHub Pages serves the repo at https://smehl86.github.io/preset-doctor/.
  base: '/preset-doctor/',
  resolve: {
    alias: [{ find: /^@preset-doctor\/core$/, replacement: coreIndex }],
    dedupe: ['react', 'react-dom'],
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [noNodeCore(), react(), devCsp()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // The preload polyfill fetch()es chunks; the CSP allows no fetches and there is one chunk.
    modulePreload: { polyfill: false },
  },
});
