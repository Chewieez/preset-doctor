# Preset Doctor: Implementation Plan

Based on SPEC.md (Nov 5, 2026) plus a read-only look at the real `%APPDATA%\BambuStudio` on this machine.

## Status (Nov 5, 2026)

| Item | State |
|---|---|
| Scaffold, step 0 | Done. Step 0 was **blocked**: Chromium refuses everything under `%APPDATA%`. So the main form is **7b, the desktop app** (SPEC §2). A web version on a copy of the folder ships too (row below). |
| M0 fixtures | Done. `npm run fixtures` writes `healthy`, `broken-r1`, `broken-r4` and `multi-account`, with ids anonymized. |
| M1, M2 core + CLI | Done. Covers R1 (refined candidate ranking), R4, the R5-lite cloud-sync warning, `fix` (plan, apply, stale check), zip backup and restore, and `scan`/`fix`/`backups` in the CLI. All tests pass. A live read-only scan finds the 18 real orphans, each with one high-confidence fix. |
| Open questions 1-4 | Still open; they need testing in Studio. Defaults are in SPEC §10. |
| M3 desktop app | In progress (`apps/desktop`, Electron + electron-vite + electron-builder portable exe). |
| Web version | Done (`apps/web`, GitHub Pages). Same UI as the desktop app (`packages/ui`), `fsaFs` over a picked copy of the folder, backups inside it, a required "I've closed Bambu Studio" checkbox, copy-out/copy-back guide. Unit tests on a fake handle, e2e in Edge on OPFS. |
| M4 ship | README, LICENSE, CI and release workflows, and the issue template are in place. Remaining: screenshots, the first `v*` tag, and posts. |

Everything below is the original plan and is kept for reference. Where the two disagree, SPEC §2 and §10 and this status section win.

## Findings from the real folder that change the spec

| # | Observation | Impact |
|---|---|---|
| F1 | `.info` sidecars are `key = value` lines (`sync_info =`, `user_id`, `setting_id`, `base_id`, `updated_time`), not JSON. | Need a tiny line-based parser/serializer that preserves line order. |
| F2 | Missing sidecars are common: the main account (fixture id `1000000001`) has 56 `.json` / 38 `.info`; the second account (`1000000002`) has 18 / 0. All the `... 06` presets lack one. | R4 "missing .info" would flag ~36 healthy presets. Make it `info` severity, not "Broken", until we know whether Studio cares. |
| F3 | User preset keys are written in alphabetical order, 4-space indent. | Serializer: `JSON.parse` keeps insertion order, so `JSON.stringify(obj, null, 4)` round-trips. Also detect and keep the existing line ending (CRLF vs LF) and trailing newline. Add a round-trip test: every fixture file must come back byte-identical. |
| F4 | `inherits` values include ` 0.6 nozzle` (e.g. `Generic PLA @BBL X2D 0.6 nozzle`, 34 of them). | Tier 1 of R1 only toggles ` 0.4 nozzle`, which is right (non-0.4 suffixes are presumably always explicit). Tier 2 (same stem + printer, any nozzle) covers the rest. Tier 2 should prefer the same nozzle size as the original string. |
| F5 | `user\<id>\filament\base\` holds wizard presets named like `... @Bambu Lab X2D 0.4 nozzle`. | Include `base\` in the user-side name index so children of wizard presets don't false-positive as orphans. |
| F6 | `system\BBL.json` has 2050 `filament_list` entries; profile version `02.08.00.06`. | Build the system index from BBL.json `sub_path`s, and warn (not fail) if an entry's file is missing. |
| F7 | `user\default` exists but has 0 filament presets. | User id picker should show preset counts and default to the account with the most presets. |

## Repo setup (before M0)

- npm workspaces (npm 11 is installed; pnpm isn't). Node 24.
- Root: `package.json` (workspaces `packages/*`, `apps/*`), `tsconfig.base.json` (strict, ES2022, `moduleResolution: bundler`), Vitest at root, ESLint + Prettier minimal.
- `packages/core` built with `tsc` (or `tsup` for the CLI bin). No runtime deps if possible.
- `.gitignore` must exclude any copy of a real `user\` folder that holds account ids you don't want public. **Decide before committing fixtures**: anonymize ids (real id -> `1000000001`) and strip `user_id` in sidecars. Personal preset names are probably fine but review them.
- First commit: SPEC.md, PLAN.md, scaffolding.

## M0: fixtures + step 0 (half a day)

1. **Step 0 browser test** (do first, ~5 min): `scratch/picker.html` with one button calling `showDirectoryPicker({ mode: 'readwrite' })`, then lists entries and writes/deletes `preset-doctor-test.txt`. Serve via `npx http-server` and also open from `file://`. Try picking `%APPDATA%\BambuStudio\user` and `...\system`. Record result in SPEC.md section 2. This picks 7a vs 7b.
   - Note: Chromium's blocklist is about the picked folder itself; also try picking `%APPDATA%\BambuStudio` (the root), since we want one pick, not two.
2. **Fixtures** in `packages/core/src/__fixtures__/`:
   - `healthy/`: trimmed copy of `system\` (BBL.json + only the filament files actually referenced, plus their inherit chains, to keep the repo small) and one anonymized `user\<id>\` with `filament\`, `filament\base\`, sidecars.
   - `broken-r1/`: same, with suffix flipped on a few `inherits` (both directions: add ` 0.4 nozzle` where system has none, strip it where system needs it), plus one with a stem that only exists for another printer (tier 3), plus one with no candidates at all.
   - `broken-r4/`: bad JSON, missing `name`, name/filename mismatch, missing sidecar.
   - `multi-account/`: two ids + `default`.
   - A script `scripts/make-fixtures.ts` that does the trimming + anonymizing from the live folder, so fixtures can be regenerated after the next Studio update.

## M1: read side + R1 + `scan` (1-2 days)

Core fs interface (`fs.ts`), the only I/O surface:
```ts
interface PresetFs {
  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;   // adapter does temp+rename or write+verify
  list(dir: string): Promise<{ name: string; kind: 'file' | 'dir' }[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
}
```
Paths are always `/`-joined relative to the root; adapters translate. Implementations: `nodeFs` (core, used by CLI/tests/desktop), `memFs` (tests), later `fsaFs` (web).

Modules:
- `jsonFile.ts`: parse with format sniffing (indent, EOL, trailing newline, BOM), serialize back identically. Round-trip test over all fixtures.
- `infoFile.ts`: parse/serialize the `key = value` sidecar (F1).
- `systemIndex.ts`: read BBL.json -> `Map<name, {path, setting_id, inherits, compatible_printers?}>`. Lazy-load file bodies; for R1 only names + `setting_id` are needed, and names come from BBL.json directly.
- `userScan.ts`: list `user\*`, for each id list `filament\*.json` and `filament\base\*.json`, pair with `.info`. Returns `UserPreset { id, path, raw, json | parseError, info?, format }`.
- `resolve.ts`: `resolveParent(name, {system, user})` and `chain(preset)` with cycle guard. User presets can inherit from user presets in the same account.
- `names.ts`: parse a preset name into `{ stem, vendorTag ('@BBL' | '@Bambu Lab' | ...), printer, nozzle? }`. Example: `Generic PLA @BBL X2D 0.4 nozzle` -> stem `Generic PLA`, printer `X2D`, nozzle `0.4`. Heavily unit-tested on all 2050 system names (assert every name parses).
- `rules/r1.ts`: orphan check + candidate ranking (tiers from spec, with F4 tweak). Output `Finding { ruleId, severity, presetPath, explanation, proposedFix? }` where `proposedFix = { kind: 'setInherits', candidates: [{ name, confidence, settingId, preselected }] }`.
- `scan.ts`: run all rules for a root + user id.
- `cli.ts`: `preset-doctor scan <root> [--user <id>] [--json]`. Human output: a table grouped by status. Bin via `package.json#bin`.

Tests: Vitest against fixtures via `nodeFs`; `broken-r1` must produce exactly the expected findings and pre-selections; `healthy` must produce zero R1 findings. Also a guarded test (`PRESET_DOCTOR_LIVE=1`) that scans the real `%APPDATA%` read-only.

## M2: write side + R4 (1-2 days)

- `rules/r4.ts`: parse failure, missing `name`, name != filename stem (fixable: rewrite `name`, and `filament_settings_id[0]` if it equaled the old name; confirm against fixtures), missing sidecar (`info` severity per F2).
- `fix.ts`: `planFixes(findings, choices) -> Change[]` where `Change = { path, before, after }` (pure), then `applyChanges(fs, changes)`. Diffs come from `before`/`after`, so the UI and `--dry-run` share one code path. R1 change edits `inherits` only, preserving format; `base_id` update behind a flag until open question 1 is answered.
- `backup.ts`: `backup(fs, userDir) -> backupId` copies the whole `user\` tree to `user_backup_<timestamp>\` via the fs interface (works for both adapters); desktop additionally zips. `listBackups`, `restore(backupId)` (restore = back up current state first, then copy back). Session flag ensures one backup before first write.
- CLI: `preset-doctor fix <root> --dry-run` prints unified diffs (use the small `diff` package, or a hand-rolled line diff since changes are one line). `fix <root> --apply --yes` takes high-confidence pre-selected fixes only; refuses if `bambu-studio.exe` is running (`tasklist` check in the CLI's node adapter).
- **Answer open questions now**, on a copy of the real folder with Studio (shortcut: point Studio at it isn't possible, so: back up `%APPDATA%\BambuStudio`, break one preset by hand, observe, repair with the CLI, observe). Record answers in SPEC.md section 10:
  1. `base_id` needed? 2. Hidden vs Unsupported (sets R1 wording). 3. Cloud sync wins? Does bumping `updated_time` help? 4. Any cache to clear?
  These decide whether `fix.ts` also touches `.info`, so do them before M3.

## M3: UI (2-3 days)

One screen per SPEC section 8, built on `scan` + `planFixes` + `applyChanges` + `backup`.

- **If 7a (web)**: `apps/web` Vite + React. `fsaFs.ts` adapter over `FileSystemDirectoryHandle` (write = `createWritable()`, then re-read and compare). Persist the handle in IndexedDB so returning users don't re-pick. Required "I've closed Bambu Studio" checkbox gates Fix. Zip backup download via a small lib (fflate, inlined in bundle). CSP meta tag `connect-src 'none'` to make the no-network claim enforceable. Deploy to GitHub Pages via Actions.
- **If 7b (desktop)**: `apps/desktop` Electron + React (electron-vite). Main process owns `nodeFs` + core; renderer talks over a narrow typed IPC (`scan`, `plan`, `apply`, `backup`, `restore`, `isStudioRunning`). Auto-detect `%APPDATA%\BambuStudio`. Package with electron-builder (portable exe, unsigned; README explains the SmartScreen prompt).
- Components: Header (root, user id picker with counts), FindingsTable (name / OK / Hidden / Broken / reason), DetailPanel (explanation, candidate radio list with confidence badges, diff), FixBar, Footer (restore, "No data leaves your computer", not-affiliated disclaimer, donation link).
- Verify end-to-end: copy of real folder -> real folder -> presets reappear in Studio.

## M4: ship (1 day)

- Pick the final name (no "Bambu" in it). README with before/after screenshots, a 3-step usage guide, the safety list, and the disclaimer.
- GitHub repo public, Pages or Release, Ko-fi link.
- Post: GitHub issues #8988 and #11894, the forum threads, one r/BambuLab post.
- Fallback per spec: if M3 drags, ship the CLI alone (`npx preset-doctor scan`) first.

## Order of work, at a glance

1. Scaffold repo, commit.
2. Step 0 browser test -> record 7a/7b.
3. `make-fixtures` script + fixtures (anonymized).
4. `jsonFile`, `infoFile`, `names` with tests.
5. `systemIndex`, `userScan`, `resolve`, R1, `scan` CLI.
6. Answer open questions 1-4 in Studio.
7. R4, `fix`, `backup`, `fix --dry-run` CLI.
8. UI app.
9. Ship.

## Risks

- **Naming rules change again** in a future Studio release: keep `names.ts` data-driven and test it against the full system list, so a fixture refresh catches breaks.
- **Cloud sync overwrites repairs** (open question 3): if so, the UI must say "turn off sync or log out first" and that becomes a required step like the Studio-closed checkbox.
- **Fixture privacy**: account ids and personal preset names. Anonymize in the script, review the diff before the first push.
