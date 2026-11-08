# Changelog

## 0.2.0 (2026-11-07)

The in-Studio test ([docs/real-test-checklist.md](docs/real-test-checklist.md), sections 0–3)
passed on Bambu Studio 02.09.01.70: all 18 hidden presets came back, and stayed after turning
cloud sync on (SPEC.md §10, "In-Studio results").

### Added

- **Offer filament presets on more nozzle sizes.** Studio offers a filament preset only for the
  nozzle sizes it was made for, so a preset saved on the 0.4 mm nozzle is missing on the 0.6 mm
  one. A new note, "Some presets are offered for only some of your nozzle sizes", opens a list
  of those presets (also reachable from a preset's details); the ticked ones get the other added
  nozzle sizes of their printer in `compatible_printers`, after the usual review and backup. On
  the command line: `fix --nozzles [--preset <name>]`. Studio keeps the list when the preset is
  saved later (its source saves what differs from the parent).
- **Select all / Select none** above the table tick or untick every repair in the list shown
  (a search or filter narrows it).

### Changed

- **Copies of one custom filament are a note, not "Unsupported".** "Create filament" makes one
  copy per printer (`<name> @<printer>`), and Studio lists each group under one name: the copy
  for the selected printer under "User presets", the other copies as one greyed-out entry under
  "Unsupported presets". When a group has a copy for a printer you've added, its other copies
  are now "OK, with notes" (the details name the copy in use) and summed up in a new note,
  "Copies of presets you already use on your printers" ("Show them" lists them), instead of
  needing attention. A copy with no such sibling is still Unsupported, and its details and
  table reason give the short name Studio lists it under. On a real folder this
  took 46 Unsupported filaments (13 groups) down to none, so the hidden presets come first.
- **Cloud sync note is calmer and more precise.** Bambu Studio's source shows a cloud copy that
  still names the missing parent is skipped, so it can't undo a repair, and turning sync off
  shouldn't be needed. The repair stays on this computer until the preset is saved once in
  Studio. The note is now informational instead of a warning.
- **Another printer's preset can be the suggested fix** when its compatibility list covers your
  printer and nozzle (Bambu sometimes folds one printer's preset into another's).
- **Your own presets are only suggested as a parent when Studio can use them**: presets in
  `filament/base/` whose parent is a system preset (or none) and whose file name matches.

### Fixed

- In a short window the preset table no longer runs under the fix bar and footer (it showed
  through behind them); the window scrolls instead.
- System presets are named the way Studio names them (from the name inside each file, not the
  index), so an old profile where the two differ no longer shows a healthy preset as hidden.
- `base_id` is never set equal to the preset's own `setting_id`, which Studio treats as broken.
- A preset based on a system template that presets can't be based on (an `@base` filament or an
  `fdm_*` template, `"instantiation": "false"`) is now reported as hidden, as Studio hides it.
  Before, it showed as OK.
- Printer and process suggestions are no longer cut to ten in alphabetical order, so your own
  printer can always be picked; a printer named by its code (`Bambu Lab X1C 0.4 nozzle`) now lists
  the model that code stands for (X1 Carbon) first.
- A system preset whose file has no `instantiation` key counts as a real parent, as in Studio.
  A parent the index lists under a file that carries another name is reported as no longer
  existing, not as a template, and a template parent gets its own title and reason.
- OrcaSlicer: when its filament library can't be read, parents are not checked (instead of all
  being called missing); when another vendor can't be read, a parent that isn't found "could not
  be checked", and the explanation names that vendor (not the packed .opc format). OrcaSlicer 2.2
  and earlier find parents by their exact name only, so the renamed and "Generic" fallbacks apply
  from 2.3 on. A restore skips a sync file when it can't tell whether its preset is there.
- Unsupported: the OrcaSlicer "Show unsupported presets" hint is given for filaments only (the
  setting doesn't affect the process list); the vendor is checked before an empty printer list,
  as in Studio; a preset made for one of your own printer presets that can't load points to that
  printer's repair; a custom filament's name rule reaches the presets based on it; the detail
  panel no longer says "every printer" when it can't tell; a preset based on another brand's
  presets with no printer list no longer says "your printers that fit its list use another
  profile" (it says none of your printers uses that brand's profile).
- Windows app: after switching to another folder or slicer, the next repair makes a fresh backup
  (the other slicer may have changed files unseen); the Studio status follows the folder shown,
  even when its scan failed; the slicer switch is pressed only on a default folder; before a scan,
  the backups dialog lists every backup. The "incomplete results" banner names the preset types
  whose system presets couldn't be read.
- Command line: `--type printer` leaves out the note about filament and process presets, and
  `backups restore` into a folder whose slicer can't be told checks that neither slicer runs.

### Added

- **OrcaSlicer support.** Preset Doctor now also scans and repairs `%APPDATA%\OrcaSlicer`, and
  tells the two slicers apart by their files. It follows how OrcaSlicer finds a parent: across
  vendors through its shared filament library, under a renamed preset's new name, and through
  the "Generic" fallback; presets OrcaSlicer still loads that way are "OK, with notes" with the
  new name offered (not pre-selected). OrcaSlicer 2.5's packed presets (`.opc`) are checked for
  the parent's name only, and a parent that can't be checked is never called missing. The Windows
  app shows a **Bambu Studio | OrcaSlicer** switch when both are installed and checks for
  `orca-slicer.exe` before writing to an OrcaSlicer folder; the web version reads which slicer a
  copy is from and its guide has OrcaSlicer steps; the command line takes `--slicer bambu|orca`.
  Backups record their slicer and are never restored into the other slicer's folder, and an
  OrcaSlicer restore never puts back a sync file (`.info`) without its preset, which OrcaSlicer
  2.5 would read as "delete this preset from the cloud". Bambu Studio results are unchanged.
- **The "Unsupported" helper.** Preset Doctor reads which printers and nozzle sizes you've added
  in Studio (`BambuStudio.conf`) and marks a filament or process preset **Unsupported** when Studio
  loads it but doesn't offer it for any of them: it is only for a printer you haven't added, a
  nozzle size you haven't added, printer names Studio doesn't know, or another brand's printer
  profile. Each comes with what to do in Studio; nothing is changed. Presets made for another
  printer you've added are summed up in one note ("Show them" lists them), and so are copies of
  a custom filament whose group has a copy for one of your printers. The app shows the added
  printers above the table; the command line adds a "Loaded, but not offered for your printers"
  group. The exit code is unchanged.
- **Process and printer presets.** They are checked like filament presets, each against its own
  system presets. A process suggestion lists the printers it is for, because the new parent
  decides them. A printer suggestion is never pre-selected: you pick the printer you have. The
  app shows a tab per preset type when there is more than one; the command line takes
  `--type filament,process,printer`. An account's preset count now counts every type, so the
  default account can differ on a folder with many process or printer presets.
- SPEC.md §10 records what Bambu Studio's source code says about each open question, with
  citations, and the in-Studio results that confirm questions 2–4.
- `scripts/r1-history.ts` and [docs/r1-history.md](docs/r1-history.md): replay of every
  removed system preset across 17 Studio releases. No wrong fix was pre-selected.

## 0.1.0 (2026-11-06)

First release.

- Finds filament presets Bambu Studio stopped loading because their parent preset was renamed
  or removed, and suggests the right new parent (checked against `compatible_printers`, so a
  0.6 mm preset gets a 0.6 mm parent; nothing is pre-selected when the nozzle is ambiguous).
- Reports damaged presets and name/file mismatches.
- Backs up the whole `user` folder before the first change, shows a diff of every change, edits
  only the changed line, refuses to write while Bambu Studio is running, restores in one step.
- Windows app (portable exe, edits the real folder), web app on GitHub Pages (works on a copy of
  the folder), and a command line tool.
- No network access of any kind.
