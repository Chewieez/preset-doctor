# R1 against Bambu's real profile history

`scripts/r1-history.ts` replays every filament preset Bambu removed between two profile snapshots
from the [BambuStudio](https://github.com/bambulab/BambuStudio) repository. For each removed
preset R it writes a synthetic user preset (`from: "User"`, `inherits: R`, `name: "Test of R"`)
into an in-memory Studio folder that has the newer snapshot as `system/`. Then it runs Preset
Doctor's `scan` and checks R1's pre-selection against the profile data.

**The fix that counts as right.** A preset S in the new snapshot is an acceptable fix when it is
instantiable, has R's effective `filament_id`, and its effective `compatible_printers` lists
every entry R listed in the old snapshot. The true successor is the acceptable preset that
carries R's `setting_id`. Without one, it is the only acceptable preset. When no preset is
acceptable, the case gets one of these labels:

- **split**: the same filament still exists, but R's nozzles are now spread over several presets.
- **partial**: some of R's nozzles are gone.
- **sid-moved**: R's `setting_id` now sits on a preset for a renamed printer model.
- **none**: nothing for that filament and printer is left.

**Variants.** Each case runs six times. The user preset's `compatible_printers` is absent
(`none`), copied whole from R (`full`), or one entry of R's list at a time (`one`, which is what
Studio saves when one printer and nozzle were selected). Each of those runs once without a
`.info` sidecar and once with one whose `base_id` is R's `setting_id`. A pre-selection is
**correct** when it is an acceptable fix for that run, and **WRONG** otherwise.

## Reproducing

Fetching is the only step that uses the network. The harness itself never does, and it refuses
any path under `%APPDATA%`.

```sh
# 1. Network: blobless clone, then batch-fetch the profile blobs the snapshots need.
git clone --filter=blob:none --no-checkout https://github.com/bambulab/BambuStudio.git bs
for t in v02.08.02.61 v02.09.01.70; do                     # every tag/commit you want
  git -C bs ls-tree -r $t -- resources/profiles/BBL.json resources/profiles/BBL/filament
done | awk '{print $3}' | sort -u |
  GIT_NO_LAZY_FETCH=1 git -C bs cat-file --batch-check | awk '/missing/{print $1}' |
  git -C bs -c fetch.negotiationAlgorithm=noop fetch origin --no-tags --no-write-fetch-head \
    --recurse-submodules=no --filter=blob:none --stdin

# 2. Offline: write <dir>/<tag>/system/{BBL.json,BBL/filament/**} (folder=rev for commits).
node scripts/r1-history.ts extract bs hist v02.08.02.61 v02.09.01.70 p02.08.00.03=ba766d51

# 3. Offline, read-only: consecutive tags, or explicit pairs.
node scripts/r1-history.ts run hist --list
node scripts/r1-history.ts run hist --pairs v02.08.02.61:v02.09.01.70 --json out.json
```

## Results

Each cell reads `correct / WRONG / not pre-selected`, then how many runs list an acceptable fix as
a candidate, out of the runs that have one. The `base_id` variants are left out because they
never differ from the runs without a sidecar. Three columns per variant:

- **reported**: the first run of the harness, which named presets by their `BBL.json` entry.
- **before**: R1 as of 32404d4, with presets named as Studio names them (by the `name` inside each
  file). This change to the harness, and the matching one in `systemIndex.ts`, removes one
  artifact (see "The SUNLU case" below).
- **after**: R1 with this change. Another printer's preset whose `compatible_printers` lists the
  target printer and nozzle now ranks high (`rules/r1.ts`).

**A. 16 consecutive release tags.** These are the last tag of each minor release from v01.07 to
v02.09, plus v01.07.00.65, v02.08.00.50 and v02.08.02.61. Only 5 of the 16 pairs removed anything.

| | removed | truth | none | full | one |
|---|---|---|---|---|---|
| reported | 11 | 1 setting_id, 1 split, 9 none | 0/0/11, 1/1 | 1/0/10, 1/1 | 3/0/24, 3/3 |
| before | 10 | 1 split, 9 none | 0/0/10 | 0/0/10 | 2/0/24, 2/2 |
| after | 10 | 1 split, 9 none | 0/0/10 | 0/0/10 | 2/0/24, 2/2 |

The only real successor in any release pair is the split of `Bambu PLA Basic @BBL X2D` (for the
0.6 and 0.8 nozzles) into `… X2D 0.6 nozzle` and `… X2D 0.8 nozzle`, between 02.08.00.01 and
02.08.00.05. R1 rightly asks for the nozzle when the user preset doesn't say. When the preset
names one nozzle, R1 picks the right preset.

**B. Commit-level profile versions.** These come from the first-parent histories of `master`
and `v1.7.2_1016`: the last commit of each `BBL.json` version, and only the 15 pairs where a
filament name disappeared. Two of these pairs go backwards in version.

| | removed | truth | none | full | one |
|---|---|---|---|---|---|
| reported | 136 | 1 setting_id, 36 single, 1 split, 3 sid-moved, 95 none | 0/0/136, 27/37 | 1/0/135, 27/37 | 3/0/231, 39/51 |
| before | 135 | 36 single, 1 split, 3 sid-moved, 95 none | 0/0/135, 26/36 | 0/0/135, 26/36 | 2/0/231, 38/50 |
| after | 135 | 36 single, 1 split, 3 sid-moved, 95 none | **36/0/99, 36/36** | **36/0/99, 36/36** | **50/0/183, 50/50** |

All 36 "single" cases come from the pair 02.03.00.04 → 02.03.00.03. Commit abfaa6300 ("ENH:split
preset files") gave the P1S its own presets. d2f7dc2ea ("Fix: Merge filament presets that don't
need to be split") folded them back 43 first-parent commits later, for example
`Bambu PLA Wood @BBL P1S 0.4 nozzle` into `Bambu PLA Wood @BBL X1C`, whose `compatible_printers`
lists `Bambu Lab P1S 0.4 nozzle`. Both commits are only on `master`, between v02.03.01.51 and
v02.04.00.70, and neither tag has a P1S Wood preset. This is real profile data, but from a state
that was never released. So the change that fixes these cases is hardening: no shipped update is
known to have needed it. Before it, R1 listed the fix only at `low` in 26 of the 36 cases. In the
other 10 it didn't list it at all, because the 10 `low` slots fill alphabetically (A1, …, X1) and
`X1C` fell off the end.

**C. Each tag above jumping straight to v02.09.01.70**, as for a user who updates rarely. That is
15 pairs: the v02.08.04.61 pair is left out because set A already has it.

| | removed | truth | none | full | one |
|---|---|---|---|---|---|
| reported | 24 | 2 setting_id, 4 split, 18 none | 0/0/24, 2/2 | 2/0/22, 2/2 | 10/0/33, 10/10 |
| before | 22 | 4 split, 18 none | 0/0/22 | 0/0/22 | 8/0/33, 8/8 |
| after | 22 | 4 split, 18 none | 0/0/22 | 0/0/22 | 8/0/33, 8/8 |

**In total**, the sets have 1,268 runs over 107 distinct removed presets. **No pre-selection was
WRONG, before or after.**

That headline is weaker than it sounds:

- Most runs pre-select nothing. Before the change, the runs held only 2 distinct pre-selections:
  the X2D split, one per nozzle. After it, they hold 38: those 2 plus the 36 P1S cases from the
  unreleased state.
- The `base_id` variants are idealised. They always set `base_id` to the removed preset's own
  `setting_id`. In real sidecars, 14 of 38 point at another preset: 11 at another nozzle, 2 at
  another printer, 1 at no system preset (`node scripts/r1-simulate.ts` prints these counts). So
  "base_id changed nothing" shows only that it never helped. It can't show a wrong `base_id`
  misleading R1.
- Real user presets come in two shapes. Either they have no `compatible_printers` and a `.info`
  sidecar (`none` + `base_id`), or they list exactly one printer and nozzle and have no sidecar
  (`one`, like the 18 real orphans). Nobody has the `full` shape.

The live checks are unchanged by this change:

- `node scripts/r1-simulate.ts` on 02.08.00.06 still gives 0 WRONG over 4,087 scenarios, with
  identical counts in every row. The simulator resolves parents through `studioNameLookup`,
  exactly as the scan does, so these runs exercise `findByStudioName` too. (02.08.00.06 has no
  file whose name differs from its index entry, so this lookup and the index agree there.)
- The live scan still finds 18 hidden presets in the account, each with a pre-selected high fix,
  and with the same fixes as before.

### The SUNLU case was an artifact

At v02.00.02.57, `BBL.json:3785` lists `SUNLU PETG @BBL A1M` for the file
`SUNLU/SUNLU PETG @BBL A1M.json`. The `name` inside that file is `SUNLU PETG @BBL A1M 0.4
nozzle`. Studio names system presets by the name inside the file (`PresetBundle.cpp:3924` at
v02.00.02.57 / 904dc26c; `:6631` at v02.09.01.70 / 56a57d00), so to Studio the preset was always
`… 0.4 nozzle`. In v02.01.01.52, only the listing changed to match. Counting it as a rename was the
harness's mistake, and that mistake supplied the only `setting_id` case in sets A and C.

Preset Doctor's system index made the same mistake. With those two profiles (and dev version
02.00.01.09), a healthy preset inheriting `SUNLU PETG @BBL A1M 0.4 nozzle` was reported as hidden.
R1 then pre-selected `SUNLU PETG @BBL A1M` at high confidence, a name Studio doesn't know. Fixed:
`systemIndex.ts` now resolves parents through `findByStudioName`, and R1 offers system presets
under their Studio names. No current profile has a mismatch (v02.01 onward, 02.08.00.06 and
v02.09.01.70 included), so live results don't change.

## What was changed in R1, and what wasn't

| Suggestion | Evidence | Done? |
|---|---|---|
| Rank another printer's preset by what its `compatible_printers` covers. Never let the `low` cap drop it. | 36 cases, all from the unreleased state above. It is safe on 02.08.00.06 and v02.09.01.70: there, each (filament_id, printer + nozzle) pair is covered by exactly one system preset, so this can't create a second high candidate. | **Yes.** If two candidates both fit, nothing is pre-selected, as before. SPEC §5 is updated to match. |
| Offer system presets under Studio's names, and resolve parents that way. | Studio's loader, above. | **Yes** (`systemIndex.ts`, `scan.ts`, `rules/r1.ts`). |
| Offer only user presets Studio can use as a parent: `filament/base/` presets with a system parent or none, whose file name is their name. | Studio's loader (`Preset.cpp:1425-1427, 1455, 1516, 1598` at v02.09.01.70); SPEC §10 question 2. | **Yes** (`rules/r1.ts`). Before, a top-level user preset could be pre-selected, and Studio would still have skipped the repaired preset. |
| Use `base_id` as a tie-break for the `" 0.4 nozzle"` toggle. | Only the SUNLU artifact. 37% of real `base_id`s point elsewhere. | No. |
| Look `base_id` up across the whole index. | 3 cases from the unreleased N1 printer. 2 of 38 real `base_id`s name another printer. | No. |
| Build on `filament_id`, or match filament names loosely. | No user JSON or sidecar stores `filament_id`. No snapshot has a filament rename. | No. |
| List `Generic <same material>` at low when a brand's filament is dropped (`Bambu PPA-GF` → `Generic PPA-GF @BBL X1C/X1E/H2D`). | 3 cases, in a shipped release. | Not yet. It would only be a low, never pre-selected entry. |

## Remaining patterns: an acceptable fix exists but R1 doesn't rank it high

| pattern | cases | R1 now |
|---|---|---|
| Unsuffixed preset split per nozzle: `Bambu PLA Basic @BBL X2D` (0.6 and 0.8) → `… X2D 0.6 nozzle` (keeps the `setting_id`) and `… X2D 0.8 nozzle` | 1 (A, B), 4 (C) | Correctly not pre-selected without compat. With `one` it picks the right nozzle. |
| Printer model renamed, `setting_id` kept: `Bambu PETG Basic @BBL N1 0.4 nozzle` → `… @BBL A1M 0.4 nozzle` (pre-release, v1.7.2_1016 branch only) | 3 (B) | Not a candidate. The compat strings changed too (`Bambu Lab N1` → `Bambu Lab A1 mini`). |

None of the snapshots has a filament stem rename (such as `X` → `X (New)`) or a vendor rename.
Most removals (95 of 135 in B) are presets Bambu dropped with no successor: 0.2 mm nozzle
variants, discontinued filaments (PPA-GF), and pre-release printers (X1E, H2C PolyLite). R1
correctly pre-selects nothing for these.

**GitHub does not show the rename users actually hit.** The orphaned parents in this repo's
fixtures, such as `Generic PETG @BBL X2D 0.6 nozzle` and `Generic PLA @BBL X2D 0.6 nozzle`, are
not in any `BBL.json` on `master`, `release/20260417`, `release/20260929`, `v1.8.4` or
`v1.7.2_1016` (390 distinct versions checked). The live 02.08.00.06 system names do match
GitHub's 02.08.00.06 (commit 8945dc4c). The vanished names therefore came from a profile Bambu
shipped outside the repository. `scripts/r1-simulate.ts` stays the main measurement for that
case.

## Alias fields in Bambu's profiles

None of the profile JSON files under `resources/profiles/BBL.json` or `resources/profiles/BBL/**`,
in any of the 88 tags, has a `renamed_from`, `alias`, `old_name`, `replaced_by` or `deprecated*`
key (`git grep` over all tags). Studio's loader does support such a field:

- `PresetBundle::load_vendor_configs_from_json` reads `renamed_from`, and when there is none it
  invents `alias + name-after-@` (e.g. `Generic PLA BBL X1C`), which helps no real rename
  (src/libslic3r/PresetBundle.cpp:6487-6489, 6573-6578 at v02.09.01.70, 56a57d00).
- User presets are resolved with a plain `find_preset(inherits)`, with no renamed fallback. A
  missing parent is logged as `can not find parent` and the preset is skipped (`continue`), so it
  does not appear anywhere (src/libslic3r/Preset.cpp:1516, 1530 in `PresetCollection::load_presets`,
  same commit).
- The renamed map (`find_preset_renamed`, src/libslic3r/Preset.hpp:814) is consulted only in
  `get_preset_parent` and `get_selected_preset_parent` (Preset.cpp:2858-2863, 2877-2880) and in
  config/project loading (Preset.cpp:2317, 2356). It is never used when loading user presets.
