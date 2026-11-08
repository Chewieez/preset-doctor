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

**Update: both forms ship, with the same UI.** `apps/web` (GitHub Pages) works on a **copy**: the user copies `system`, `user` and `BambuStudio.conf` out of `%APPDATA%\BambuStudio` into a normal folder (e.g. `Documents\PresetDoctor-copy`), picks that folder, repairs it, and copies the changed files (listed on the page) back. This is still not the zip-upload fallback ruled out above: nothing is uploaded, and it edits real files in place on the copy. Use the desktop app for one-click, in-place repairs; use the web version when you can't or won't run an unsigned exe.

## 3. Decisions

| Decision | Choice |
|---|---|
| Platform | Windows first. Mac later only if people ask. |
| Language | TypeScript everywhere. Vitest for tests. |
| Distribution | Free. GitHub repo plus GitHub Pages (web) or GitHub Releases (desktop). Ko-fi or similar donation link. No licensing, no keys. |
| Scope | Filament, process and printer (machine) presets. Each type is checked against its own system presets, as Studio keeps each type in its own collection (design: `docs/design-v0.2.md` §4). |
| Slicers | Bambu Studio and OrcaSlicer, on Windows. Everything that differs lives in a `SlicerProfile` (`packages/core/src/slicer.ts`); a folder's files decide which profile applies (`BambuStudio.conf` or `OrcaSlicer.conf`, then `system/OrcaFilamentLibrary.*` before `system/BBL.json`, then a lone `user/` counts as Bambu Studio; both confs is an error). Bambu Studio output is unchanged. OrcaSlicer's differences and their sources: §11 and `docs/design-v0.2.md` §6. |

## 4. File layout the tool must handle

```
%APPDATA%\BambuStudio\
  BambuStudio.conf              app config (JSON): enabled printers, current selections, sync flag
  system\BBL.json               index of system presets: filament_list, process_list, machine_list [{name, sub_path}]
  system\BBL\filament\*.json    system filament presets (may be in subfolders, e.g. P1P\)
  system\BBL\process\*.json     system process presets (fdm_process_* are templates, not selectable)
  system\BBL\machine\*.json     system printer presets, plus g-code template files without a "type"
  user\<id>\filament\*.json     user presets (<id> = numeric account id, or "default" when logged out)
  user\<id>\filament\*.info     sidecar per preset: sync_info, user_id, setting_id, base_id, updated_time
  user\<id>\filament\base\      custom filaments made via the "Create Filament" wizard
  user\<id>\process\[base\]     user process presets, same layout
  user\<id>\machine\[base\]     user printer presets, same layout (base\: "Create Printer" wizard)
```

OrcaSlicer keeps the same `user\` layout in a different folder, with several vendors instead of one:

```
%APPDATA%\OrcaSlicer\
  OrcaSlicer.conf                   app config (JSON, optional "# MD5 checksum" trailer); "header" holds the version
  system\OrcaFilamentLibrary.json   the shared filament library; any vendor's system preset may inherit from it
  system\<Vendor>.json, <Vendor>\   one index and folder per installed vendor (BBL, Custom, Elegoo, ...)
  system\<Vendor>.opc               2.5: a packed vendor (names readable, settings not), instead of the JSON
  user\<id>\...                     as above; <id> is "default", a Bambu id or an Orca Cloud id
  user\<id>\_local\, _subscribed\   2.5: bundle presets; used only as parents, never scanned or fixed
  user\hints.cereal                 a file, not an account
  user_backup-v<version>\           Orca's own copy per update; never read, scanned or backed up
  orca_refresh_token.sec, .orcaslicer_machine_id, printers\   never read
```

System preset shape: `type`, `name`, `inherits`, `from: "system"`, `setting_id`, `instantiation`, optional `include[]`, `compatible_printers[]` (usually inherited), then setting overrides as string arrays.

User preset shape (confirm against fixtures): `name`, `inherits`, `from: "User"`, `version`, the settings id, overrides only. The settings id is `filament_settings_id` (an array) for filament, and `print_settings_id` or `printer_settings_id` (a string) for process and printer presets. Compatibility comes from the parent chain.

A system preset whose file says `"instantiation": "false"` (an `@base` filament, an `fdm_*` template) is not a valid parent: Studio never puts it in the list a user preset's parent is looked up in, so a user preset based on one is hidden.

Several `<id>` folders can exist. Scan all; let the user pick.

## 5. MVP rules

Each rule returns `{ ruleId, severity, presetPath, explanation, proposedFix? }`. Explanations are plain English for non-developers.

**R1 ORPHANED_PARENT** (the main rule; fixable)
`inherits` is non-empty and names no preset in the system index or the user folder.
Fix: rank candidate parents and let the user confirm.
1. Toggle the ` 0.4 nozzle` suffix (add if absent, strip if present). Exact hit = high confidence, pre-selected.
2. Same filament stem + same printer code, any nozzle variant. Medium confidence.
3. Same filament stem, other printer. Low confidence, never pre-selected, unless its resolved `compatible_printers` lists the target printer and nozzle: then high, like a same-printer match. Bambu has folded one printer's presets into another's (`Bambu PLA Wood @BBL P1S 0.4 nozzle` into `... @BBL X1C`, which lists the P1S 0.4 nozzle; see `docs/r1-history.md`).

Names are the ones Studio uses: a system preset is named by the `name` inside its file, not by its `BBL.json` entry (they differ in a few old profiles). A user preset is only offered as a parent when it is in `filament/base/`, has a system parent or none, and its file name equals its name: Studio can't use a top-level user preset as another top-level preset's parent (§10, question 2).
Apply: rewrite `inherits`. Also update `base_id` in the `.info` sidecar to the new parent's `setting_id` (open question 1: harmless, Studio never resolves through it).

R1 runs per type, and parents only resolve within the same type. The steps above are the filament ranking. Process presets are matched by layer height, profile and the printers the parent lists (a process's printers come from its parent, so the new parent decides which printers Studio offers it for). Printer presets are matched by printer model and nozzle, and are **never** pre-selected: the user picks the printer they have. Details: `docs/design-v0.2.md` §4.5, §4.6 and §4.11.

**R4 MALFORMED** (report; one fix)
JSON parse failure, missing `name`, `name` different from the filename stem, or missing `.info` sidecar. Auto-fix only the name/filename mismatch. Runs for every type; the rename also rewrites that type's settings id, and only clashes with names of the same type.

**R2 PRINTER_NOT_ADDED and R3 NOZZLE_NOT_ADDED** (report-only, severity `info`, status `unsupported`; never a fix)
For presets Studio **does** load, but doesn't offer for any printer that is added in Studio: filaments sit greyed out under "Unsupported presets", processes are left out of the process list (§10, finding 5). Filament and process presets only: Studio has no compatibility check for printer presets.
Inputs come from `BambuStudio.conf`: `models` (the added printers: vendor, `printer_model` and the added nozzle sizes), `presets.machine` and `presets.process`. Nothing else in the conf is read (it also holds device access codes). The preset's printer list is its own `compatible_printers` if its file has the key, even `[]`, otherwise the nearest ancestor's; a custom filament with no parent and an empty list takes the part of its name after `@`, as Studio does. In order:
1. No list and no condition: fine for every printer. A `compatible_printers_condition` with an empty list: "can't tell" (Studio evaluates it; Preset Doctor never guesses).
2. The list names the selected printer (or, for a user printer, its direct parent): fine.
3. It names another added printer (or a printer preset of the user's own): fine, counted in one scan-level note `R3_NOT_FOR_SELECTION` ("made for another printer you've added"). Filaments that list only other processes in `compatible_prints` are counted there too.
4. It names an added printer of another vendor profile (e.g. a BBL-based filament for a printer made with the wizard): R2, "another brand's printer profile" (Studio's vendor check).
5. An entry's printer model is added, but not with that nozzle size: R3, "add that nozzle in Studio's printer selection".
6. Otherwise R2: the printers it is for aren't added ("add that printer in Studio, or ignore or delete the preset"), or no profile defines them ("probably renamed or removed in an update"). Names that no profile defines are read as `<model> <d> nozzle` and marked as read from the name.

Skipped: presets R1 or R4 report as hidden or broken (and their children), files with `"instantiation": "false"`, and every preset when the conf is missing, unreadable or lists no printers (the UI then shows one muted line; nothing else changes). Editing `compatible_printers` would fight Studio's "save only what differs from the parent" model, so R2/R3 never offer a fix. Details: `docs/design-v0.2.md` §5.

**R5 CLOUD_SYNC** (an `info` note; see §10, question 3).

## 6. Safety (non-negotiable)

- Never write while Bambu Studio is running. Desktop: detect `bambu-studio.exe`. Web: can't detect it, so show a required "I've closed Bambu Studio" checkbox before the Fix button enables. The same for OrcaSlicer with `orca-slicer.exe` and "I've closed OrcaSlicer"; when a folder's slicer can't be told, both must be closed.
- Before the first write of a session, back up the whole `user\` folder. Desktop: zip to `%APPDATA%\PresetDoctor\backups\<timestamp>.zip`. Web: the same zip, written to `preset-doctor-backups\` inside the picked folder (and offered as a download). Restore from a list of backups (the current state is backed up first).
- A backup records its slicer (none recorded = Bambu Studio) and is never restored into the other slicer's folder, with no override. A restore writes each `X.json` before its `X.info`. For OrcaSlicer, a restore never creates a lone `.info`: a backed-up `X.info` whose `X.json` is neither in the backup nor on disk is skipped and reported, because OrcaSlicer 2.5 reads a lone `.info` with a `setting_id` as "delete this preset in the cloud" (§11).
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

Both are built (see §2): `apps/desktop` repairs the real folder in place; `apps/web` repairs a copy the user picks, and the user copies the changed files (listed on the page) back. They share one UI in `packages/ui` (the screen plus the `PresetDoctorApi` contract); `AppConfig.platform` switches the few differences (Studio process check vs. a required "I've closed Bambu Studio" checkbox, open-backups-folder vs. download, the copy-out/copy-back guide).

## 8. UI (one screen)

1. Header: preset folder (picked or detected), user id picker, Studio-closed warning.
2. **Scan** button, then a table: preset name, status (OK / Hidden / Broken), reason.
3. Row click opens a detail panel: explanation, proposed fix, JSON diff, candidate picker for R1.
4. **Fix selected**: backup, apply, result summary.
5. Footer: **Restore a backup…**, "No data leaves your computer," not-affiliated disclaimer, donation link.

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

**Status (Nov 7, 2026): answered from Bambu Studio's source code and confirmed in Studio for questions 2, 3 and 4** (results below). Question 1 (`base_id`) wasn't exercised, because none of the real orphans has a sidecar; it stays answered from the source only. `docs/real-test-checklist.md` is the test script, with what the source predicts at each step. The tool uses these defaults (also written in the header of `packages/core/src/fix.ts`):

| # | Default | Why / how to change |
|---|---|---|
| 1 | `base_id` **is updated** to the new parent's `setting_id`, but only when the sidecar exists, already has a `base_id` line, and the new parent is a system preset. | This matches what Studio writes for a freshly created preset (`base_id` = parent `setting_id`). Studio itself fills `base_id` only when it is empty and leaves it stale when `inherits` changes (see finding 1 below), so leaving it alone is also a state Studio creates; updating it was kept because it matches a fresh preset. Turn it off with `--no-base-id` (CLI) or `updateBaseId: false` (API). The 18 real orphans have no sidecar, so in practice it rarely applies. |
| 2 | R1 wording says Studio **hides** the preset ("Hidden in Studio"). | The source says it isn't loaded at all, so it is in no list, "Unsupported" included. Change the wording in `rules/r1.ts` only if testing shows otherwise. |
| 3 | `updated_time` and `sync_info` are **never touched**. When `BambuStudio.conf` has `sync_user_preset: true`, the scan adds one note (`R5_CLOUD_SYNC`): turning sync off shouldn't be needed, the repair usually isn't uploaded on its own, and saving the preset in Studio uploads it. | The source says the orphaned cloud copy can't undo the repair, so no option to bump `updated_time` or set `sync_info` is offered: uploading is Studio's job, and a hand-made upload flag risks the cases below. Revisit if testing shows the cloud copy wins. |
| 4 | **No caches are cleared.** After a repair the user is told to reopen Studio and check that the presets are back. | The source has no on-disk preset list. Add a cache-clearing step only if testing finds one. |

### In-Studio results (Nov 7, 2026)

Run by the maintainer on their own account folder: Bambu Studio **02.09.01.70** (Windows), system profile **02.09.00.75**, the X2D with all four nozzle sizes added, logged in. It covered checklist sections 0–3, on 18 orphaned filament presets (`inherits: "… @BBL X2D 0.6 nozzle"`, own `compatible_printers: ["Bambu Lab X2D 0.6 nozzle"]`, no sidecar). Every prediction matched.

- **Profile update:** updating Studio from 02.08.02.61 and accepting "A new configuration package is available" (02.08.00.06 → 02.09.00.75) did **not** bring the `… 0.6 nozzle` parents back. The 18 stayed orphaned.
- **Question 2 (1.2–1.4):** the orphans were in no list: not in the sidebar dropdown, not under "Unsupported presets", not in the filament settings tab. That tab offered no "show incompatible" option. A loaded preset with a 0.4-nozzle parent showed greyed out and unclickable under "Unsupported presets" on the 0.6 nozzle. The "Hidden in Studio" wording stands.
- **Repair, sync off (2.1–2.8):** `"sync_user_preset": false` after unticking sync in Preferences. The scan found 18 hidden, each with a pre-selected high-confidence fix to the unsuffixed parent. Repairing one preset changed only its `inherits` line (checked against the backup zip) and created no sidecar. After a plain restart it was back on the 0.6 nozzle, greyed under "Unsupported presets" on the 0.4 nozzle, and Studio changed no file under `user/`. The other 17 were then repaired; all 18 showed on the 0.6 nozzle. Scan: 0 hidden.
- **Question 4:** nothing needed clearing. A plain restart was enough.
- **Question 3, sync on (3.1–3.3):** after turning sync on, waiting a few minutes, and restarting Studio, all 18 stayed visible. None of their `.json` files changed and no `.info` appeared, so the orphaned cloud copies did not overwrite the repairs. Studio did rewrite the `.info` sidecars of about 190 other, already-synced presets, both when sync was turned off and when it was turned on; that is its own bookkeeping (finding 4: a running Studio rewrites sidecars while it syncs). Steps 3.4–3.5 (upload after Save, deletion from another computer) and sections 5–6 were not run.
- **More nozzle sizes (checklist section 7), same day, sync on:** "Offer presets on more nozzle sizes" on one filament (parent `… @BBL X2D 0.4 nozzle`, no list of its own) added `compatible_printers` with the X2D 0.2/0.4/0.6/0.8 nozzles and nothing else. Studio then showed it normally on the other nozzle sizes with its own values. After a value was changed and saved in Studio on the 0.6 nozzle, the file still listed all four nozzles, and Studio uploaded it (its sidecar got a new `updated_time` and an empty `sync_info`).

### Source-code findings (confirmed in Studio for questions 2–4, see above)

Read from [bambulab/BambuStudio](https://github.com/bambulab/BambuStudio) at tag `v02.09.01.70` (commit `56a57d00`, the latest release on Nov 6, 2026). `Preset.cpp`, `PresetBundle.cpp` and `GUI_App.cpp` are identical on `master` `355d71ee`. In `v02.08.02.61` the same code sits about 66 lines earlier in `Preset.cpp`. Paths are under `src/libslic3r/` unless they start with `slic3r/` (that is, `src/slic3r/GUI/`). A second reader checked each finding. The cloud side of sync runs in Bambu's closed-source network plugin, which could not be read.

**1. `base_id` is not used to find the parent. Confidence: high.**

- Studio finds a user preset's parent only by the exact `inherits` name (`Preset.cpp:1516`; `find_preset` is an exact lookup, `Preset.cpp:3003-3009`).
- `base_id` is read from the sidecar (`Preset::load_info`, `Preset.cpp:570-596`) and used only for cloud sync:
  - Studio sends it with an upload (`Preset.cpp:1703-1709`).
  - Studio doesn't upload a preset that has `inherits` but an empty `base_id` (`Preset.cpp:1923`).
  - A cloud download overwrites it (`Preset.cpp:2075-2079, 2160`).
- Studio fills `base_id` with the parent's `setting_id` only when `base_id` is empty (`Preset.cpp:1985-1986, 2772-2773`). It never updates it when `inherits` changes. The stale `base_id` that `--no-base-id` leaves behind is therefore a state Studio creates itself.
- Sidecar format: `save_info` writes exactly `sync_info`, `user_id`, `setting_id`, `base_id` and `updated_time`, in that order, as `key = value` lines (`Preset.cpp:613-645`). If `updated_time` is missing or `0`, Studio stamps the current time and rewrites the sidecar while loading (`Preset.cpp:604-610`).
- Never make `base_id` equal to `setting_id`. Studio then clears `setting_id`, both on load (`Preset.cpp:1563`) and before an upload (`slic3r/GUI_App.cpp:6914-6917`), which cuts the preset off from its cloud copy. `fix.ts` refuses that edit.
- Default kept: update `base_id` when the line exists and the new parent is a system preset.

**2. An orphan is never loaded, so it appears in no list, not even "Unsupported". Confidence: high.**

- `PresetCollection::load_presets` loads `filament/base/` first (`Preset.cpp:1425-1427`) and names each user preset after its **file** (`Preset.cpp:1455`).
- When the parent isn't found, Studio logs `can not find parent %1% for config %2%!` and skips the preset (`Preset.cpp:1528-1531`). The file stays on disk unchanged.
- Studio never re-parents an orphan. It doesn't consult `renamed_from` aliases here, and no BBL profile in any tag defines one anyway.
- "Unsupported presets" lists presets that **did** load but don't match the selected printer and nozzle, or the selected process preset (`Preset.cpp:821-843, 3081-3117`; `slic3r/PresetComboBoxes.cpp:1717-1720, 1851`). A greyed-out preset there has a wrong-nozzle parent or a process mismatch. It is not an orphan.
- The settings tab hides incompatible presets unless "show incompatible" is on, but it always shows the selected one (`slic3r/PresetComboBoxes.cpp:2133-2135`).
- Studio collects top-level user presets in one pass and adds them to the list only after the pass ends (`Preset.cpp:1598`). So a top-level preset can't be another top-level preset's parent, and a `base/` preset can only have a system parent. R1 therefore offers only `base/` presets with a system parent (or none) as user parents. `resolve.ts` still accepts any user parent when it walks chains, so a top-level → top-level or `base/` → user chain is reported healthy although Studio hides it. No real folder has such a chain, so fixing that is left as a follow-up. `resolve.ts` does look user parents up by file name only, as Studio does: a child that inherits a preset's internal `name` when it differs from that preset's file name is reported hidden, and R1 and R4 say why.
- Studio also drops presets silently in these cases:
  - The file name matches a name that is already loaded ("Preset already present", `Preset.cpp:1459`).
  - The `"version"` key is missing (`Preset.cpp:1491-1492`, nothing logged). Fixes never remove keys, and a test checks that `version` survives.
  - The preset has a newer major version (`Preset.cpp:1496`).
- **If a user preset's JSON can't be parsed, Studio deletes both its `.json` and `.info` files** (`Preset.cpp:1480-1489, 1569-1587`). Preset Doctor's temp-file-then-rename write and the "Studio must be closed" rule therefore stay mandatory.
- Studio names a system preset by the `name` inside its file, not by its `BBL.json` entry (`PresetBundle.cpp:6631`; `:3924` at `v02.00.02.57`). `systemIndex.ts` resolves parents the same way.

**3. With cloud sync on, the orphaned cloud copy can't undo a repair, but the repair usually isn't uploaded either. Confidence: high for Studio's own code, medium where the closed-source plugin decides.**

- **What happens on login or startup with sync on:**
  - Studio first reloads the user folder from disk.
  - It then downloads only the cloud presets that are missing locally, have a different `setting_id`, or have a newer `update_time` (`need_sync`, `Preset.cpp:1905-1912`; `slic3r/GUI_App.cpp:1189-1190, 2052-2062, 7028-7044`).
  - `load_user_preset` keeps the local copy when the cloud copy is not newer (`Preset.cpp:2052-2069`).
  - Before applying any cloud copy, Studio looks up that copy's own `inherits`. A copy that still names the missing parent is skipped with `can not find inherit preset ... just skip` (`Preset.cpp:2112-2124`), however new it is.
- **Result: a repaired file stays repaired on this computer, whether sync is on or off.** The cloud copy wins only if it is newer and its parent exists, for example a copy fixed and saved on another computer.
- **Why the repair usually isn't uploaded:**
  - Studio uploads only presets whose sidecar it has flagged (`sync_info` not empty, other than `hold`) or that don't have a `setting_id` yet (`Preset.cpp:1915-1931`, `1922-1926`). A preset with `inherits` and an empty `base_id`, which includes every preset without a sidecar, is never uploaded (`Preset.cpp:1923`).
  - So an edit made outside Studio leaves `updated_time` unchanged and is not uploaded when the sidecar is missing, or has a `setting_id` and an empty `sync_info`; the cloud and other computers keep the broken copy.
  - The exceptions: a sidecar with a `base_id` but no `setting_id` yet (made offline, never uploaded), or with `sync_info = create` or `update` still pending. Once the repair makes such a preset load, Studio uploads it within about two seconds, as a new cloud preset when it has no `setting_id` (`slic3r/GUI_App.cpp:6849-6877`; the sync loop ticks every 100 ms and acts on every 20th tick, `:7051-7053, 7141`). That is harmless, even useful. The 18 real orphans have no sidecar, so for them it doesn't apply.
  - Saving the preset in Studio sets `sync_info = update` and uploads it (`slic3r/Tab.cpp:7733-7743`, `slic3r/GUI_App.cpp:6911-6945`).
- **Why Preset Doctor doesn't flag the upload itself:**
  - Writing `sync_info = update` plus a newer `updated_time` (in epoch seconds) by hand would also trigger an upload. It only works if `setting_id` and `base_id` are both non-empty and differ from each other.
  - It isn't needed for the repair to stick, and wrong values send Studio down its "create a new cloud preset" path (`slic3r/GUI_App.cpp:6849-6877, 6940-6944`).
  - A preset without a sidecar is never uploaded automatically (`Preset.cpp:1923`), and Preset Doctor never creates a sidecar.
- **Risk to document (confidence: medium):**
  - On every sync, Studio deletes the local files of a **loaded** user preset whose name is missing from the cloud list, if that preset has a `setting_id` and an empty `sync_info` (`PresetBundle.cpp:1447-1468`, run at `:960`).
  - An orphan isn't loaded, so this can't touch it. Once repaired, it is loaded, so it can be deleted if its cloud record was deleted elsewhere. Backups cover this case.
- Turning sync off only postpones all of this. Studio offers to turn it back on at every online login (`slic3r/GUI_App.cpp:6016-6027`, `slic3r/MainFrame.cpp:4923-4970`).

**5. Which loaded presets Studio offers, and where the others go (R2/R3). Confidence: high for the checks, medium for how processes show.**

- A loaded user preset is built from its parent's config with its own keys on top (`Preset.cpp:1521-1526`; `PrintConfig.cpp:10455-10470`), and Studio saves only the keys that differ from the parent (`Preset.cpp:685-722`). So `compatible_printers` is in a user file only when it differs.
- `is_compatible_with_printer` (`Preset.cpp:821-843`):
  - a preset whose vendor (the nearest ancestor's, `get_preset_with_vendor_profile`, `Preset.cpp:2921-2933`) differs from the printer's is incompatible (`:823-825`);
  - a condition counts only when the list is empty, and a parse error counts as compatible (`:829-837`);
  - otherwise the list must be empty or name the printer (`:838-840`), or, for a user printer, its direct parent only ("FIXME only check the parent", `:811-819, 842`).
- `update_compatible_internal` (`Preset.cpp:3081-3123`) runs that check, and for filaments also `is_compatible_with_print` against the selected process (`:784-804, 3113-3114`). Processes are checked against the printer only (`PresetBundle.cpp:7382-7383`). A multi-nozzle-size mode also accepts sibling nozzle presets (`Preset.cpp:3105-3110`), but it is a project setting (`PresetBundle.cpp:3575-3620`), so Preset Doctor can't see it.
- A system printer is shown only when the conf's `models` lists its `printer_model` and `printer_variant` (`set_visible_from_appconfig`, `Preset.cpp:879-884`; `AppConfig.cpp:696-707, 1199-1205`). User printers have no vendor and are always shown (`Preset.cpp:877`).
- Filaments that don't fit go to the bottom group "Unsupported presets", greyed out with a red flag (`slic3r/PresetComboBoxes.cpp:1717-1729, 1851`). Processes have no such group: an incompatible process is left out unless it is the selected one (`slic3r/PresetComboBoxes.cpp:2126-2135`), and the "show incompatible" button seems to be switched off (`slic3r/Tab.cpp:290, 656-657`; confidence medium, on the checklist).
- A user file with `"instantiation": "false"` loads but is never shown (`Preset.cpp:1505-1506`).

**4. There is no on-disk cache of the preset list. Confidence: high.**

- Studio rebuilds the user preset list from `user/<id>/filament/*.json` (and `base/`) on every start, login and account switch (`PresetBundle.cpp:570-575, 900-930`; `slic3r/GUI_App.cpp:2056, 5334, 6019`). Nothing else under `user/<id>` is read as an index.
- The `[presets]` section of `BambuStudio.conf` holds only the names of the selected presets. If a selected preset is missing, Studio falls back to the first compatible one (`PresetBundle.cpp:2157-2216, 2367-2378`).
- The only cache is Studio's memory. Studio must therefore be closed during a repair and reopened afterwards. A running Studio also rewrites sidecars while it syncs (`Preset.cpp:1875-1902`).

## 11. OrcaSlicer source findings

Read from [OrcaSlicer/OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) at tags `v2.5.0` and `v2.3.2` (the live install on the test machine is 2.3.2-rc). Paths are under `src/` unless they start with `.github/` or `scripts/`. Like §10, these come from reading the source, not from watching OrcaSlicer; `docs/real-test-checklist.md` lists what to confirm. The design with every decision is `docs/design-v0.2.md` §6.

**1. Where the folder is and what to read.**

- The data folder is `%APPDATA%\OrcaSlicer`, also for the MSIX build (`slic3r/GUI/GUI_App.cpp:2744, 2779-2783@v2.5.0`; `scripts/msix/AppxManifest.xml:22-31@v2.5.0`).
- `OrcaSlicer.conf` is JSON with an optional `# MD5 checksum` trailer (`libslic3r/AppConfig.cpp:741-774@v2.5.0`). Preset Doctor reads only `header` (the version), `app.sync_user_preset`, `app.cloud_providers` (`libslic3r/AppConfig.cpp:1024-1031@v2.5.0`), `app.show_unsupported_presets`, `app.preset_folder` (`libslic3r/PresetBundle.cpp:900-905@v2.5.0`), `models`, `presets` and `orca_presets` (the process per printer, `libslic3r/AppConfig.cpp:943-949@v2.5.0`).
- The process is `orca-slicer.exe` (`CMakeLists.txt:223-229@v2.5.0`). `user.lock` and `OrcaSlicer.conf.lock` are short-lived locks, not a running signal (`libslic3r/InstanceLock.hpp:9-22@v2.5.0`).
- `user_backup-v<version>\` folders are written once per version and never read (`libslic3r/PresetBundle.cpp:1047-1068@v2.5.0`).

**2. System presets come from many vendors, and the library is shared.**

- Every `system/<V>.json` loads, `OrcaFilamentLibrary` first; on a duplicate name the first one wins (`libslic3r/PresetBundle.cpp:3338-3341, 3361-3372@v2.5.0`; `libslic3r/Preset.cpp:4388-4404@v2.5.0`).
- A vendor's system preset may inherit from its own vendor or from `OrcaFilamentLibrary`, and nothing else (`libslic3r/PresetBundle.cpp:7797-7826@v2.5.0`).
- 2.5 can ship a vendor as one packed `system/<V>.opc` without the JSON (`.github/workflows/build_orca.yml:522-527@v2.5.0`), and installing one removes the JSON and the folder (`slic3r/Utils/PresetUpdater.cpp:147-163@v2.5.0`). The file is a 20-byte header (magic, version, sizes, CRC-32) over an uncompressed body of length-prefixed strings (`libslic3r/PresetCacheFormat.cpp:317-333, 435-470@v2.5.0`). Preset Doctor checks the CRC and looks names up as whole strings; it never reads settings from it.
- There is no vendor check in the compatibility test (`libslic3r/Preset.cpp:904-907@v2.5.0`), unlike Studio (§10, finding 5). From 2.4 the "Unsupported presets" group is hidden unless `show_unsupported_presets` is on (`slic3r/GUI/PresetComboBoxes.cpp:1505-1507@v2.5.0`); up to 2.3 it is always shown (`slic3r/GUI/PresetComboBoxes.cpp:1356@v2.3.2`).

**3. A missing parent is looked for in more places than in Studio.**

The user preset loader calls `find_preset2` with `auto_match` (`libslic3r/Preset.cpp:1907-1917@v2.5.0`), which tries, in order (`libslic3r/Preset.cpp:3894-3931@v2.5.0`):

1. the exact name among the presets OrcaSlicer lists (templates with `"instantiation": "false"` are not among them);
2. the system presets' `renamed_from` names, followed recursively in 2.5 and one step in 2.3 (`libslic3r/Preset.cpp:2738-2764@v2.3.2`). The map is built with the first entry winning (`libslic3r/Preset.cpp:4466-4479@v2.5.0`). `renamed_from` is split like `unescape_strings_cstyle` (`libslic3r/PresetBundle.cpp:8484-8488@v2.5.0`; `libslic3r/Config.cpp:173-242@v2.5.0`). A system preset with neither `alias` nor `renamed_from` gets one derived from its name (`libslic3r/PresetBundle.cpp:7934-7943@v2.5.0`);
3. for a name with "Generic" in it, the name rewritten to `Generic <material> @System` (`libslic3r/Preset.cpp:3919-3921@v2.5.0`), then steps 1 and 2 again.

In 2.5 a parent may also be a bundle preset, `_local/<id>/<name>` or `_subscribed/<id>/<name>` (`libslic3r/Preset.cpp:106-131@v2.5.0`), loaded before plain presets (`libslic3r/PresetBundle.cpp:1445-1520@v2.5.0`). Preset Doctor reports a preset found through steps 2 or 3 as **OK, with notes** (it loads), offers the new name without pre-selecting it, and treats a bundle or `.opc` parent as present with unknown settings. A parent that may be in an unreadable `.opc` is "could not be checked", never hidden.

**4. User files and the cloud.**

- The `.info` format is Studio's (`libslic3r/Preset.cpp:701-760@v2.5.0`), and a preset without `version` is dropped as in Studio (`libslic3r/Preset.cpp:1893-1897@v2.5.0`).
- Cloud sync follows Studio's logic: `need_sync` (`libslic3r/Preset.cpp:2479-2486@v2.5.0`), the upload filter (`:2489-2502`), a cloud copy applied only when newer (`:2636-2652`) and skipped when its parent is missing (`:2714-2721`). So the R5 note reads as for Studio, naming Orca Cloud and the Bambu cloud.
- **A `.info` without its `.json` is a delete order in 2.5.** At startup OrcaSlicer queues every lone `.info` with a `setting_id` under `user/<id>/<type>[/base]` for deletion in the cloud (`slic3r/Utils/CloudDeleteQueue.cpp:128-168@v2.5.0`). Hence the restore rule in §6.