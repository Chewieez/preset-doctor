# Preset Doctor: MVP Spec (trimmed Nov 5, 2026)

A small free tool that finds custom Bambu Studio filament presets that disappeared after a Studio update and repairs the ones it safely can. Free on GitHub, optional donation link.

Working name only. The final name must not imply Bambu Lab affiliation ("for Bambu Studio" plus a not-affiliated disclaimer is fine; "Bambu Preset Doctor" is not).

## 1. Problem

After Studio updates, user filament presets vanish from the dropdown or land in "Unsupported." The files are still on disk. Users fix this by hand-editing JSON in `%APPDATA%`, logging out and in, or recreating presets. Reported from Studio 1.7 through 2.8.x.

Main cause: a user preset stores its parent by **name** in `inherits`. Bambu renames system presets between releases, and naming is inconsistent. Seen in `resources/profiles/BBL.json` (profile version 02.08.00.06):

- `Bambu PLA Basic @BBL X1C` (no suffix = 0.4) but `Bambu PLA Basic @BBL P1S 0.4 nozzle` (explicit suffix)
- `Generic PLA @BBL X2D` and `Generic PLA @BBL X2D 0.4 nozzle` both exist

On Shawn's X2D, six presets carried `... @BBL X2D 0.4 nozzle` in `inherits` and vanished on the 0.6 nozzle; a preset Studio itself wrote used `Generic PETG @BBL X2D` with no suffix. Stripping the suffix fixed them.

When the named parent no longer exists, the child is orphaned and hidden.

## 2. Step 0: pick the form (do this first, 5 minutes)

The plan is a static web app on GitHub Pages (no install, no unsigned-exe warning), using the File System Access API in Chrome or Edge.

**Risk:** Chromium blocks some sensitive folders from `showDirectoryPicker()`, and AppData may be one of them. Test before writing anything else:

1. Make a scratch HTML page with a button that calls `showDirectoryPicker({ mode: 'readwrite' })`.
2. Open it in Chrome on Windows, both from `http://localhost` and from a local file.
3. Try to pick `%APPDATA%\BambuStudio\user` and `%APPDATA%\BambuStudio\system`.
4. Record whether it opens, whether you can read the files, and whether you can write a test file.

- **Works:** build the web app (section 7a).
- **Blocked:** build a desktop app instead (section 7b). Do not build a "drop a zip, download fixed files" web fallback; it's too clunky for the users this is for.

Either way, the core library and CLI come first and don't change.

**Result (Nov 5, 2026): blocked. Decision: 7b (desktop app).** Chromium's File System Access blocklist includes `DIR_ROAMING_APP_DATA` (`%APPDATA%`) with `kBlockAllChildren`, so `%APPDATA%` and every folder under it are refused by `showDirectoryPicker()`, including `%APPDATA%\BambuStudio`, `...\user` and `...\system`. Source: `chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc` (the blocked-paths list). Consequence: `apps/desktop` (Electron + React via electron-vite, packaged with electron-builder as a portable unsigned Windows exe, released on GitHub Releases) is the main form, because it repairs in place.

**Update: both forms ship, with the same UI.** `apps/web` (GitHub Pages) works on a **copy**: the user copies `system`, `user` and `BambuStudio.conf` out of `%APPDATA%\BambuStudio` into a normal folder (e.g. `Documents\PresetDoctor-copy`), picks that folder, repairs it, and copies `user` back. The page lists exactly which files changed. This is still not the zip-upload fallback ruled out above: nothing is uploaded, and it edits real files in place on the copy. Use the desktop app for one-click, in-place repairs; use the web version when you can't or won't run an unsigned exe.

## 3. Decisions

| Decision | Choice |
|---|---|
| Platform | Windows first. Mac later only if people ask. |
| Language | TypeScript everywhere. Vitest for tests. |
| Distribution | Free. GitHub repo plus GitHub Pages (web) or GitHub Releases (desktop). Ko-fi or similar donation link. No licensing, no keys. |
| Scope | Filament presets only. Core stays type-agnostic so process and machine presets can come later. |
| Slicers | Bambu Studio only. Root path is config, so OrcaSlicer (`%APPDATA%\OrcaSlicer`) can come later. |

## 4. File layout the tool must handle

```
%APPDATA%\BambuStudio\
  BambuStudio.conf              app config (JSON): enabled printers, current selections, sync flag
  system\BBL.json               index of system presets: filament_list[{name, sub_path}]
  system\BBL\filament\*.json    system filament presets (may be in subfolders, e.g. P1P\)
  user\<id>\filament\*.json     user presets (<id> = numeric account id, or "default" when logged out)
  user\<id>\filament\*.info     sidecar per preset: sync_info, user_id, setting_id, base_id, updated_time
  user\<id>\filament\base\      custom filaments made via the "Create Filament" wizard
```

System preset shape: `type`, `name`, `inherits`, `from: "system"`, `setting_id`, `instantiation`, optional `include[]`, `compatible_printers[]` (usually inherited), then setting overrides as string arrays.

User preset shape (confirm against fixtures): `name`, `inherits`, `from: "User"`, `version`, `filament_settings_id`, overrides only. Compatibility comes from the parent chain.

Several `<id>` folders can exist. Scan all; let the user pick.

## 5. MVP rules

Each rule returns `{ ruleId, severity, presetPath, explanation, proposedFix? }`. Explanations are plain English for non-developers.

**R1 ORPHANED_PARENT** (the main rule; fixable)
`inherits` is non-empty and names no preset in the system index or the user folder.
Fix: rank candidate parents and let the user confirm.
1. Toggle the ` 0.4 nozzle` suffix (add if absent, strip if present). Exact hit = high confidence, pre-selected.
2. Same filament stem + same printer code, any nozzle variant. Medium confidence.
3. Same filament stem, other printer. Low confidence, never pre-selected.
Apply: rewrite `inherits`. Also update `base_id` in the `.info` sidecar to the new parent's `setting_id` if testing shows it matters (open question 1).

**R4 MALFORMED** (report; one fix)
JSON parse failure, missing `name`, `name` different from the filename stem, or missing `.info` sidecar. Auto-fix only the name/filename mismatch.

**Later, not MVP:** R2 printer not enabled, R3 nozzle mismatch (both report-only, need `BambuStudio.conf` keys), R5 cloud sync warning.

## 6. Safety (non-negotiable)

- Never write while Bambu Studio is running. Desktop: detect `bambu-studio.exe`. Web: can't detect it, so show a required "I've closed Bambu Studio" checkbox before the Fix button enables.
- Before the first write of a session, back up the whole `user\` folder. Desktop: zip to `%APPDATA%\PresetDoctor\backups\<timestamp>.zip`. Web: copy it to `user_backup_<timestamp>\` next to `user\` (and offer a zip download). One-click restore.
- Show a diff of every proposed change. Nothing is written without an explicit click.
- Write safely (temp file then rename on desktop; write-then-verify on web). Preserve key order and 4-space indentation so diffs stay small.
- No network calls of any kind. Say so in the UI.

## 7. Architecture

```
packages/core/        pure TS, no Electron or browser imports; filesystem behind an injected interface
  systemIndex.ts      load BBL.json + preset files -> Map<name, preset>
  userScan.ts         enumerate user ids, presets, sidecars
  resolve.ts          walk the inherit chain
  rules/r1.ts, r4.ts  one file per rule
  fix.ts              apply fixes
  backup.ts           backup + restore
  cli.ts              `preset-doctor scan <root> [--json]`, `preset-doctor fix <root> --dry-run`
  __fixtures__/       real preset folders, healthy and broken
packages/ui/          the shared React screen and the PresetDoctorApi contract (window.presetDoctor)
apps/web/   (7a)      Vite + React, File System Access API adapter for the core fs interface, on a copy
apps/desktop/ (7b)    Electron + React, node fs adapter, thin UI over core via IPC, in place
```

Both are built (see §2): `apps/desktop` repairs the real folder in place; `apps/web` repairs a copy the user picks, and the user copies `user` back. They share one UI in `packages/ui` (the screen plus the `PresetDoctorApi` contract); `AppConfig.platform` switches the few differences (Studio process check vs. a required "I've closed Bambu Studio" checkbox, open-backups-folder vs. download, the copy-out/copy-back guide).

## 8. UI (one screen)

1. Header: preset folder (picked or detected), user id picker, Studio-closed warning.
2. **Scan** button, then a table: preset name, status (OK / Hidden / Broken), reason.
3. Row click opens a detail panel: explanation, proposed fix, JSON diff, candidate picker for R1.
4. **Fix selected**: backup, apply, result summary.
5. Footer: **Restore backup**, "No data leaves your computer," not-affiliated disclaimer, donation link.

## 9. Milestones

- **M0 fixtures + step 0.** Copy real `system\` and `user\` folders into `__fixtures__/healthy`. Make `__fixtures__/broken-r1` by flipping the suffix on a few `inherits` strings. Run the step 0 browser test.
- **M1:** system index, user scan, resolver, R1, CLI `scan`. Vitest against fixtures.
- **M2:** fixer, backup/restore, R4.
- **M3:** UI (web or desktop per step 0). Test on a copy of the real folder, then the real folder, and confirm presets reappear in Studio.
- **M4 ship:** README with before/after screenshots, GitHub Pages or Release, donation link, replies on the existing forum threads and GitHub issues (#8988, #11894), one post on r/BambuLab.

**Done means:** posted publicly and one stranger has used it. If M3 drags, ship the CLI alone first.

## 10. Open questions (answer by testing on the fixtures and in Studio, not from research)

1. Does Studio care about `base_id` in the `.info` sidecar when `inherits` changes, or is `inherits` enough?
2. Does Studio hide an orphaned preset silently or list it under Unsupported? Sets R1 wording.
3. With cloud sync on, does a local edit win or does the cloud copy overwrite it on next login? Does bumping `updated_time` make local win?
4. Does Studio cache the preset list anywhere that needs clearing after a repair?

**Status (Nov 5, 2026): all four are still open.** Each one needs a person watching Studio, and they can't be answered from the fixtures. Until someone tests them, the tool uses these defaults (also written in the header of `packages/core/src/fix.ts`):

| # | Default | Why / how to change |
|---|---|---|
| 1 | `base_id` **is updated** to the new parent's `setting_id`, but only when the sidecar exists, already has a `base_id` line, and the new parent is a system preset. | Studio writes `base_id` = parent `setting_id` itself, so this matches what Studio would have written. Turn it off with `--no-base-id` (CLI) or `updateBaseId: false` (API). The 18 real orphans have no sidecar, so in practice it rarely applies. |
| 2 | R1 wording says Studio **hides** the preset ("Hidden in Studio"). | Change the wording in `rules/r1.ts` if testing shows it goes to "Unsupported" instead. |
| 3 | `updated_time` is **never touched**. When `BambuStudio.conf` has `sync_user_preset: true`, the scan adds one warning (`R5_CLOUD_SYNC`): "Turn off preset sync or log out of Bambu Studio before repairing, or the cloud copy may undo the fix." | Bumping `updated_time` might make the local copy win, but it's untested, so the safe option is to ask the user to turn sync off first. |
| 4 | **No caches are cleared.** After a repair the user is told to reopen Studio and check that the presets are back. | Add a cache-clearing step only if testing finds a cache. |
