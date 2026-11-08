# Preset Doctor desktop app

Electron + React (electron-vite), packaged by electron-builder for Windows and macOS.

```
npm run desktop:dev          # from the repo root: dev server + Electron with hot reload
npm run desktop:e2e          # build, then the end-to-end smoke test (also writes docs/screenshots/)
npm run desktop:dist:mac     # build release/PresetDoctor-<version>-{arm64,x64}.dmg
npm run desktop:dist:win     # build release/PresetDoctor-<version>-portable.exe
npm run icon -w apps/desktop # regenerate build/icon.* and the other icon copies
```

## Layout

- `src/main/`: the main process. `service.ts` does all the work (scan, plan, apply, backups) over
  `@preset-doctor/core`, with no Electron imports, so it is unit-tested directly. `ipc.ts` wires it
  to IPC, `security.ts` locks the app down and `index.ts` creates the window.
- `src/preload/`: the sandboxed bridge. It exposes exactly `PresetDoctorApi` (the contract in
  `packages/ui/src/contract.ts`; `src/shared/api.ts` adds the IPC channel names).
- `src/renderer/`: just `index.html` (strict CSP), the icon and an entry that mounts the shared UI
  from `packages/ui`, the same screen the web version (`apps/web`) uses. The UI never touches files.
- `e2e/smoke.mts`: drives the built app with playwright-core on a temp copy of the `broken-r1` fixture,
  and switches between temp copies of a Bambu Studio and an OrcaSlicer fixture.

Core and the UI are bundled from source (see `electron.vite.config.ts`), so the packaged app ships no
`node_modules` and never picks up a stale `packages/core/dist`.

## Two slicers

The app knows both default folders, `%APPDATA%\BambuStudio` and `%APPDATA%\OrcaSlicer`. It starts on
Bambu Studio's (OrcaSlicer's when Bambu Studio isn't installed) and shows a **Bambu Studio |
OrcaSlicer** switch in the header when both exist; switching scans the other folder. A folder's
files decide which slicer it is (`detectSlicer` in core), for picked folders too.

## Safety

- Every write is refused while the folder's slicer is running (`bambu-studio.exe` or
  `orca-slicer.exe`; both when the files don't tell), or when the process check fails.
- Each backup records its slicer, and a restore into the other slicer's folder is refused.
- One backup zip of the whole `user\` folder is made per session (and per folder) before the first write.
- `apply` takes a plan id. The main process keeps the exact edits it previewed, so the UI can't
  change what gets written.
- Context isolation, sandbox, no Node in the renderer, a strict CSP (`connect-src 'none'`), all
  navigation and new windows blocked, permissions denied, and every non-`file:` request cancelled.

## Environment overrides (testing, or working on a copy)

| Variable | Effect |
|---|---|
| `PRESET_DOCTOR_ROOT` | Folder to open instead of `%APPDATA%\BambuStudio` (a folder of either slicer) |
| `PRESET_DOCTOR_BACKUPS` | Backups folder instead of `%APPDATA%\PresetDoctor\backups` |
| `PRESET_DOCTOR_FAKE_STUDIO_RUNNING` | `0` or `1` replaces the Studio process check, only for writes to `PRESET_DOCTOR_ROOT` (never a folder picked later). Ignored unless `PRESET_DOCTOR_ROOT` is set to a folder other than the real Bambu Studio and OrcaSlicer folders. The app shows a test-mode banner |
| `PRESET_DOCTOR_BAMBU_ROOT`, `PRESET_DOCTOR_ORCA_ROOT` | With `PRESET_DOCTOR_ROOT` only: the folders the slicer switch offers. Without them a test run offers no switch, so it never opens a real folder |
| `PRESET_DOCTOR_USER_DATA` | Electron's own profile folder (the e2e test uses a temp one) |
| `PRESET_DOCTOR_E2E_EXE` | e2e only: test a packaged exe, e.g. `release/win-unpacked/Preset Doctor.exe` |

## Donation link

`DONATION_URL` in `src/shared/constants.ts` is empty on purpose, so the footer link is hidden.
Set it to an `https://` URL to show it. It opens in the user's own browser.
