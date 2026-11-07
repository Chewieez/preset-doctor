# In-Studio test checklist

This is the test that settles [SPEC.md §10](../SPEC.md#10-open-questions-answer-by-testing-on-the-fixtures-and-in-studio-not-from-research).
Each step says what Bambu Studio's source code (tag `v02.09.01.70`) predicts. Your job is to
confirm or refute each prediction. The citations are in SPEC.md §10, "Source-code findings". It
takes about 30 minutes. You need the X2D printer profile with a 0.6 nozzle, and the account
folder that has the 18 hidden "... 06" presets.

The 18 presets have three things in common, and the predictions depend on them:

- each one has `inherits: "... @BBL X2D 0.6 nozzle"`, a name that profile 02.08.00.06 doesn't have;
- each one has its own `compatible_printers: ["Bambu Lab X2D 0.6 nozzle"]`;
- none of them has a `.info` sidecar.

**Ground rules**

- Preset Doctor writes only while Studio is closed, and so do you.
- Never edit anything under `%APPDATA%\BambuStudio` by hand during the test, except when
  restoring a backup.
- Use the 0.1.0 exe, or the CLI from this repo. On your folder both make exactly the same
  suggestions (checked read-only on a copy of it).

Write down each result as you go. The section at the bottom says what to send back.

## 0. Before you start

1. In Studio, open **Help → About** and note the Studio version. Then close Studio and check in
   Task Manager that `bambu-studio.exe` is gone.
2. **Make an extra manual backup**, separate from Preset Doctor's own. In File Explorer, copy
   `%APPDATA%\BambuStudio\user` and `%APPDATA%\BambuStudio\BambuStudio.conf` into a new folder
   such as `Documents\PresetDoctor-manual-backup-<date>`. Don't copy the whole BambuStudio
   folder: its logs are huge. To undo everything later, close Studio and copy these two back,
   replacing what's there.
3. Note whether preset sync is on: open `BambuStudio.conf` in Notepad, read only, and look for
   `"sync_user_preset"`. Note also whether you are logged in.

You can't use Studio's logs as evidence: they are encrypted (`*_enc.log`). Studio logs
`can not find parent ... for config ...` for each orphan, but you can't read it there.

## 1. Before the repair: hidden or "Unsupported"? (question 2)

1. Open Studio. Select the X2D with the **0.6 nozzle**.
2. Open the filament dropdown in the left sidebar and look for `Anycubic Petg 06`, and for any
   other "... 06" preset.
   - **Predicted:** it is **nowhere**. It is not in the normal list and not under the greyed
     "Unsupported presets" group.
3. Open the filament settings (the edit icon next to a filament) and the preset dropdown there.
   Turn on the option to show incompatible presets, if your version has it.
   - **Predicted:** still not there.
4. Control check: pick one of your **working** presets whose parent is a 0.4 nozzle preset (for
   example one based on `Generic PLA @BBL X2D 0.4 nozzle`).
   - **Predicted:** with the 0.6 nozzle selected, it shows **greyed out under "Unsupported
     presets"**. That is what a loaded but incompatible preset looks like, and it is different
     from the orphans.
5. Close Studio and check that it has exited.

## 2. Sync off → repair → check (questions 1, 2 and 4)

1. Open Studio and turn **off** user preset sync in **Preferences**. Close Studio and make sure it
   exited.
   - **Predicted:** `"sync_user_preset": false` in `BambuStudio.conf`.
2. Run Preset Doctor and click **Scan**, or run `npm run cli -- scan`.
   - **Predicted:** 18 **Hidden** presets in this account. Each one has a pre-selected
     high-confidence fix: the same name without ` 0.6 nozzle`, for example
     `Anycubic Petg 06` → `Generic PETG @BBL X2D`.
   - **Predicted:** no "Cloud preset sync is on" banner.
3. **Repair one preset first.** Select only `Anycubic Petg 06`, check that the diff changes only
   the `inherits` line, and click **Fix selected**. Note the backup id Preset Doctor shows.
   - **Predicted:** one file changed. No `.info` file is created or changed, because these
     presets have none.
4. Open Studio. Don't clear anything and don't log in or out. Select the X2D with the 0.6 nozzle.
   - **Predicted:** `Anycubic Petg 06` is back in the filament dropdown as a normal entry, right
     after start. No cache needs clearing (question 4).
5. Select the preset and open its settings. Compare a few values you set yourself, such as
   nozzle temperature and flow ratio, with the `.json` in your manual backup.
   - **Predicted:** your values are all there. Only the parent changed.
6. Switch to the **0.4 nozzle**.
   - **Predicted:** the preset shows greyed out under **"Unsupported presets"**. Its own
     `compatible_printers` lists only the 0.6 nozzle. That is expected and correct.
7. Close Studio. Check the preset's files:
   `user\<account>\filament\Anycubic Petg 06.json` (and `.info` if one appeared).
   - **Predicted:** the `.json` is exactly as Preset Doctor left it, and no `.info` was created.
     Studio only rewrites a file on load in two cases: it stamps `updated_time` into a sidecar
     that lacks one, and it adds `compatible_printers` to presets with no parent. Neither applies.
8. If all of that matched, repair the other 17 the same way (sync still off). Open Studio and
   check that all 18 are back on the 0.6 nozzle.

## 3. Sync on → check (question 3)

1. Open Studio, log in if you aren't, and turn user preset sync **on** in Preferences. Wait two
   minutes with Studio open.
   - **Predicted:** all 18 stay visible and unchanged. None of them has a sidecar, so Studio
     doesn't upload them. A cloud copy that still names the missing `... 0.6 nozzle` parent is
     skipped and can't replace them.
2. Close Studio, open it again (this syncs at startup), and check again.
   - **Predicted:** still all 18, unchanged.
3. Close Studio. Look at the 18 files again.
   - **Predicted:** no `.json` changed and no `.info` appeared.
   - If a `.info` appeared for a preset, or its `.json` changed, the cloud had a copy with a
     parent that resolves, and it won. Report that, with that file's text (see below).
4. **Optional, tests the upload path.** Open Studio, open the settings of one repaired preset
   (say `Anycubic Petg 06`), click the **Save** icon and confirm saving under the same name.
   Wait one minute, then close Studio.
   - **Predicted:** `Anycubic Petg 06.info` now exists. It has a `setting_id` (starts with
     `PFUS`), a `base_id` equal to the `setting_id` of `Generic PETG @BBL X2D`, and an empty
     `sync_info` (Studio clears it after a successful upload). Studio saved it as a new cloud
     preset.
   - If you have a second computer with the same account and the same Studio version, the
     preset should show up there after you log in.
5. **Optional, tests a deletion risk (medium confidence).** Skip this unless you want to know.
   If you delete a synced preset's cloud copy from another computer, Studio on this computer
   should delete the local repaired file at the next login. Restore it from Preset Doctor's
   backup.

## 4. If something goes wrong

Close Studio. In Preset Doctor, click **Restore a backup…** and pick the backup from before the
fix, or run `npm run cli -- backups restore <id> --yes`. If that doesn't work, copy the manual
backup from step 0 back into `%APPDATA%\BambuStudio`, replacing the files there.

## 5. "Unsupported" presets (R2/R3, optional, about 10 minutes)

This checks the "Unsupported" helper (SPEC.md §5, R2 and R3; source findings in SPEC.md §10,
finding 5). It needs no repair and writes nothing. Close Studio, scan with Preset Doctor, and note
which presets it marks **Unsupported**, and which ones the note "Some presets are for another
printer you've added" lists (click **Show them**). The steps that add or remove a printer or
nozzle change Studio's own settings: undo them in Studio afterwards.

1. **R2, process.** Open Studio and select the X2D. Look for the process preset Preset Doctor
   marks Unsupported (it is made for the H2D) in the process list of the left sidebar, and in the
   Process settings tab.
   - **Predicted:** it is in neither list: Studio has no "Unsupported" group for processes.
     Note whether the sidebar and the Process tab behave the same way (this is the
     medium-confidence part).
2. **R2, filament.** Open the filament dropdown and look for a filament Preset Doctor marks
   Unsupported.
   - **Predicted:** it is greyed out under "Unsupported presets", on every printer you've added.
   - Then add the printer it is made for in Studio. Note the exact menu wording you used (Preset
     Doctor says "printer selection"). **Predicted:** the preset shows normally once that printer
     is selected. Remove the printer again afterwards.
3. **R3, nozzle.** Only if you have a preset made for one nozzle size: remove that nozzle size for
   its printer in Studio, close Studio and scan again.
   - **Predicted:** Preset Doctor marks it Unsupported ("Made for the … mm nozzle, which you
     haven't added"), and in Studio it drops out of the list (process) or goes under
     "Unsupported presets" (filament). Add the nozzle back afterwards.
4. **The note.** Pick one preset that **Show them** lists, and select the printer it is made for
   in Studio.
   - **Predicted:** it shows normally there, and greyed out (filament) or not at all (process)
     on the X2D.

## 6. OrcaSlicer (optional, about 15 minutes)

This checks the OrcaSlicer support (SPEC.md §11). Your OrcaSlicer has no presets of its own yet,
so first make a few: open OrcaSlicer, create two or three filament presets from built-in ones and
save them, then close OrcaSlicer. **Make a copy of `%APPDATA%\OrcaSlicer\user` first** (as in step
0), and put it back at the end.

1. **Scan.** Open Preset Doctor. With both slicers installed the header shows a **Bambu Studio |
   OrcaSlicer** switch; click **OrcaSlicer**.
   - **Predicted:** the folder is `%APPDATA%\OrcaSlicer`, the pill says "OrcaSlicer is closed",
     and your new presets are **OK**. Open OrcaSlicer: the pill turns to "OrcaSlicer is open" and
     **Fix** is blocked. Close it again.
2. **Hidden in OrcaSlicer.** Close OrcaSlicer. In one of the new presets' `.json` files, change
   `inherits` to a made-up name that doesn't contain "Generic" (for example `Nonexistent PLA
   @System`). Scan.
   - **Predicted:** Preset Doctor marks it **Hidden in OrcaSlicer**. Open OrcaSlicer: the preset
     is in no filament list, not even under "Unsupported presets". Close OrcaSlicer, use **Restore
     a backup…** (or put the line back by hand) and check it shows again.
3. **The "Generic" fallback.** As in 2, but with a name that contains "Generic", for example
   `Generic PLA @Made Up`. Scan.
   - **Predicted:** Preset Doctor marks it **OK, with notes** ("OrcaSlicer substitutes a generic
     parent"), and OrcaSlicer still shows it, now based on `Generic PLA @System`.
4. **"Unsupported presets" on 2.3.2.** Repeat step 5.2 above in OrcaSlicer, with a filament made
   for a printer you haven't added.
   - **Predicted:** the group "Unsupported presets" is always shown on 2.3.2, with the preset
     greyed out in it.
5. **OrcaSlicer 2.4 or later** (only if you have upgraded). Repeat 4.
   - **Predicted:** there is no "Unsupported presets" group until Preferences > Developer >
     "Show unsupported presets" is on.
6. **OrcaSlicer 2.5 packed presets** (only after upgrading to 2.5). Scan.
   - **Predicted:** if `system` holds `.opc` files, Preset Doctor shows the warning about packed
     presets, and a preset whose parent it can't find there is "Parent could not be checked",
     never **Hidden**.
## What to send back

Copy this, fill in each line with **matched** or **didn't match**, and add what you saw where it
didn't match:

```
Studio version:                         (Help → About)
System profile version:                 (shown in Preset Doctor's scan header)
Sync at start:   on / off     Logged in: yes / no

1.2 orphan absent from sidebar list, also not under Unsupported:
1.3 orphan absent from the settings tab, even with "show incompatible":
1.4 working 0.4-parent preset greyed under Unsupported on 0.6 nozzle:
2.1 sync_user_preset false after turning sync off:
2.2 18 hidden, each with a pre-selected high fix (note any that differ):
2.3 one file changed, no .info:
2.4 preset back on 0.6 nozzle after a plain restart:
2.5 own settings intact:
2.6 greyed under Unsupported on 0.4 nozzle:
2.7 .json unchanged after Studio ran, no .info created:
2.8 all 18 back:
3.1 all 18 still there 2 min after turning sync on:
3.2 still there after a restart with sync on:
3.3 no .json changed, no .info appeared:
3.4 (optional) after Save: .info with setting_id PFUS..., base_id = parent's id, empty sync_info:
3.4 (optional) preset appeared on the second computer:
5.1 Unsupported process absent from the sidebar list / the Process tab:
5.2 Unsupported filament greyed under Unsupported; normal after adding its printer:
5.2 menu wording for adding a printer:
5.3 (optional) nozzle removed: Unsupported in Preset Doctor and in Studio:
5.4 a preset from "Show them" shows normally on its printer:
6.0 OrcaSlicer version:                 (Help > About)
6.1 switch shown; pill follows OrcaSlicer open/closed; new presets OK:
6.2 made-up parent: Hidden in Preset Doctor, absent in OrcaSlicer:
6.3 Generic fallback: OK with notes, still shown in OrcaSlicer:
6.4 Unsupported group shown on 2.3.2:
6.5 (2.4+) group hidden until the developer setting is on:
6.6 (2.5) packed presets: warning, "could not be checked", nothing Hidden:
```

Screenshots of the filament dropdown for 1.2, 1.4, 2.4 and 2.6 are the most useful.

When a step doesn't match, also paste that preset's `.json` and, if it has one, its `.info`.
**Before pasting, replace the numbers after `user_id =` and `setting_id =` with `X`, and remove
the account folder number from any path.**
