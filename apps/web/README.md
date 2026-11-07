# Preset Doctor web version

A static Vite + React site, published to <https://shmehltr.github.io/preset-doctor/> by
[`.github/workflows/pages.yml`](../../.github/workflows/pages.yml). It shows the same screen as the
desktop app (`packages/ui`) and runs core in the page.

```
npm run web:dev       # from the repo root: dev server with hot reload
npm run web:build     # apps/web/dist (base path /preset-doctor/)
npm run web:preview   # serve the build locally
npm run web:e2e       # build, then the end-to-end smoke test in Edge or Chrome
```

## Why it works on a copy

Chromium's File System Access API refuses every folder under `%APPDATA%`, so the user copies
`system`, `user` and `BambuStudio.conf` (or, for OrcaSlicer, `system`, `user` and
`OrcaSlicer.conf` from `%APPDATA%\OrcaSlicer`) into a normal folder, picks it here, and copies the
changed files back. The guide on the page walks through that, with a switch for the OrcaSlicer
steps, and after a fix it lists exactly which files changed (relative to the slicer's folder). The
copy's files tell which slicer it is (`detectSlicer` in core); a whole `BambuStudio` or
`OrcaSlicer` folder copied into the picked one is used as it is.

## Layout

- `src/install.ts`: puts a `BrowserDoctor` on `window.presetDoctor`. `main.tsx` imports it first,
  then mounts the shared UI, or a "use Chrome or Edge" page when the browser has no
  `showDirectoryPicker`.
- `src/browserDoctor.ts`: the browser twin of `apps/desktop/src/main/service.ts`, with the same plan
  ids, stale checks and one backup per session before the first write. Backups are core's zip
  backups in a `preset-doctor-backups` folder inside the picked folder, and can be downloaded.
  `studioStatus()` is always `unknown`; the UI asks the user to tick "I've closed Bambu Studio"
  (or OrcaSlicer) before Fix or Restore. Backups record the slicer; one from the other slicer's
  folder is never restored.
- `src/fsaFs.ts`: core's `PresetFs` over a `FileSystemDirectoryHandle`. Writes use
  `createWritable()` (Chromium swaps the file in on close), then re-read and compare.
- `src/handleStore.ts`: remembers the picked folder in IndexedDB. Permission is asked again on the
  next Scan click.
- `src/testing/fakeHandle.ts`: an in-memory handle for the unit tests.
- `e2e/smoke.mts`: drives the built site with playwright-core. The folder picker is replaced by one
  that returns a folder in the browser's private storage (OPFS) holding the `broken-r1` fixture, so
  real handles, permissions and IndexedDB are used. Writes `docs/screenshots/web*.png`.

## Safety

- CSP: `default-src 'self'; connect-src 'none'`, no inline scripts or styles, no external fonts or
  scripts. The build fails if anything imports `@preset-doctor/core/node` or a `node:` module.
- Only the picked folder is ever touched: scan and preview open it read-only; Fix and Restore write
  inside it, after a verified backup.
