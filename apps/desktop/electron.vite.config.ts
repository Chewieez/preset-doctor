import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { PluginOption } from 'vite';

// Bundle core from source, so the app never runs a stale packages/core/dist and the packaged
// app has no node_modules at all.
const coreSrc = resolve(__dirname, '../../packages/core/src');
const alias = [
  { find: /^@preset-doctor\/core\/node$/, replacement: resolve(coreSrc, 'node/index.ts') },
  { find: /^@preset-doctor\/core$/, replacement: resolve(coreSrc, 'index.ts') },
];

/** The dev server needs inline styles and a websocket for hot reload; production stays strict. */
function devCsp(): PluginOption {
  return {
    name: 'preset-doctor-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /<meta http-equiv="Content-Security-Policy" content="[^"]*"/,
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; ` +
          `script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; ` +
          `img-src 'self' data:; connect-src 'self' ws://localhost:*"`,
      );
    },
  };
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: { externalizeDeps: true },
  },
  preload: {
    resolve: { alias },
    // Sandboxed preloads can't require() packages, so bundle everything.
    build: { externalizeDeps: false },
  },
  renderer: {
    resolve: { alias },
    plugins: [react(), devCsp()],
  },
});
