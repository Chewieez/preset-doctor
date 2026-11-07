# Changelog

## Unreleased

Waiting on an in-Studio test (see [docs/real-test-checklist.md](docs/real-test-checklist.md))
before it is tagged.

### Changed

- **Cloud sync note is calmer and more precise.** Bambu Studio's source shows a cloud copy that
  still names the missing parent is skipped, so it can't undo a repair, and turning sync off
  shouldn't be needed. The repair stays on this computer until the preset is saved once in
  Studio. The note is now informational instead of a warning.
- **Another printer's preset can be the suggested fix** when its compatibility list covers your
  printer and nozzle (Bambu sometimes folds one printer's preset into another's).
- **Your own presets are only suggested as a parent when Studio can use them**: presets in
  `filament/base/` whose parent is a system preset (or none) and whose file name matches.

### Fixed

- System presets are named the way Studio names them (from the name inside each file, not the
  index), so an old profile where the two differ no longer shows a healthy preset as hidden.
- `base_id` is never set equal to the preset's own `setting_id`, which Studio treats as broken.

### Added

- SPEC.md §10 records what Bambu Studio's source code says about each open question, with
  citations (provisional until confirmed in Studio).
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
