# Preset Doctor

**Finds and repairs custom presets (filament, process and printer) that disappeared after an
update, for Bambu Studio and OrcaSlicer.**

Free, open source, works offline. Windows and macOS. Not affiliated with Bambu Lab or the OrcaSlicer project.

| Before | After |
|---|---|
| ![Preset Doctor showing hidden presets](docs/screenshots/before.png) | ![Preset Doctor after the repair](docs/screenshots/after.png) |

## What it does

You update Bambu Studio and some of your own filament presets are gone. They don't show in the
dropdown at all, not even under "Unsupported presets". The files are still on your computer, but
Studio can't use them anymore.

**Why it happens:** each custom preset remembers the Bambu preset it was based on, by **name**
(for example `Generic PETG @BBL X2D 0.6 nozzle`). Studio updates sometimes rename those built-in
presets, for example to `Generic PETG @BBL X2D`. Your preset then points at a name that no
longer exists, so Studio skips it when it loads your presets.

**What Preset Doctor does:**

1. It reads your Bambu Studio folder and lists every filament, process and printer preset as
   **OK**, **Hidden** or **Broken**, with a plain-English reason. When you have more than one
   kind, each kind gets its own tab.
2. For each hidden preset, it finds the built-in preset it most likely meant and shows how sure it
   is (high, medium or low).
3. It shows you the exact change. After you click **Fix**, it backs up your presets and changes
   only the one line that names the parent.

Process presets get their printers from the preset they are based on, so for a process the new
parent also decides which printers Studio offers it for; Preset Doctor lists them next to each
suggestion. For printer presets it never picks for you: the nozzle and printer change everything,
so you choose the printer you actually have.

It also explains presets that Studio loads but greys out under "Unsupported presets" (or, for a
process, leaves out of the list): it reads which printers and nozzles you've added in Studio and
marks a preset **Unsupported** when it is only for printers or a nozzle size you haven't added,
with what to do in Studio. It never changes those presets.

And if you made a filament preset on one nozzle size and want it on the others too (Studio offers
it only on the size it was made for), Preset Doctor can add the other nozzle sizes you've added
for that printer. See [the FAQ](#faq).

![A filament preset marked Unsupported, with the printers you have added](docs/screenshots/unsupported.png)

## Which slicers

| | Bambu Studio | OrcaSlicer |
|---|---|---|
| Folder (Windows) | `%APPDATA%\BambuStudio` | `%APPDATA%\OrcaSlicer` |
| Folder (macOS) | `~/Library/Application Support/BambuStudio` | `~/Library/Application Support/OrcaSlicer` |
| Versions checked against the source | 02.09.01.70 | 2.3.2 and 2.5.0 |
| Repairs | Yes | Yes |
| Packed built-in presets (`.opc`, OrcaSlicer 2.5) | n/a | Checks that parents exist; suggests no replacements |

Preset Doctor tells the two apart by their files (`BambuStudio.conf` or `OrcaSlicer.conf`, and the
built-in preset folders), so a folder you pick is always handled as the slicer it belongs to. When
both are installed, the desktop app shows a **Bambu Studio | OrcaSlicer** switch at the top.

OrcaSlicer differs from Bambu Studio in ways Preset Doctor follows: it finds a parent that was
renamed (when the new preset lists the old name), falls back to a generic parent for
"Generic ..." filaments, and lets any vendor's preset build on its shared filament library. A
preset OrcaSlicer still loads that way is reported as **OK, with notes**, not as hidden. Linux
isn't supported yet.

## Download

Get the app from **[GitHub Releases](https://github.com/smehl86/preset-doctor/releases)**:
- **Windows:** Download the portable `.exe` (`PresetDoctor-<version>-portable.exe`). There is nothing to install: double-click to run.
- **macOS:** Download the `.dmg` (`PresetDoctor-<version>-arm64.dmg` for Apple Silicon M1/M2/M3/M4, or `PresetDoctor-<version>-x64.dmg` for Intel Macs). Open the DMG and drag Preset Doctor to your Applications folder.

**"Windows protected your PC"**: Windows shows this for apps without a paid code-signing
certificate, and Preset Doctor doesn't have one. Click **More info**, then **Run anyway**.

**"App cannot be opened because Apple cannot check it for malicious software"**: On macOS, right-click (or Control-click) the app icon in Finder, choose **Open**, and click **Open** in the dialog (or run `xattr -cr /Applications/Preset\ Doctor.app`).

If you would rather check it first, the source code is all in this repo and release binaries are built from it by
[GitHub Actions](.github/workflows/release.yml). To check that a release was built here:
`gh attestation verify <file> -R smehl86/preset-doctor`, or compare its hash with `SHA256SUMS.txt` on the release page.

## Web version (no download)

**[smehl86.github.io/preset-doctor](https://smehl86.github.io/preset-doctor/)** runs the same
app in Chrome or Edge on your computer. Nothing is uploaded: once loaded, the page can't connect
anywhere (its security policy sets `connect-src 'none'`), so your files are only read and changed
on your computer.

**Which one should I use?**

| | Windows app | Web version |
|---|---|---|
| Steps | Scan, Fix. It repairs `%APPDATA%\BambuStudio` (or `%APPDATA%\OrcaSlicer`) in place. | Copy folders out, Scan, Fix, copy the changed files back. |
| Checks that the slicer is closed | Yes, on its own. | No; you tick "I've closed Bambu Studio" (or OrcaSlicer). |
| Needs | Running an unsigned exe. | Chrome or Edge (Firefox and Safari can't open folders). |

Browsers aren't allowed to open anything under `%APPDATA%`, so the web version works on a copy:

1. **Close Bambu Studio and keep it closed** until step 4 is done.
2. Right before repairing (an older copy lacks your newer Studio changes), in File Explorer, paste `%APPDATA%\BambuStudio` into the address bar. Copy the **`system`** and
   **`user`** folders and the **`BambuStudio.conf`** file into a new folder, for example
   `Documents\PresetDoctor-copy`. Don't copy the whole BambuStudio folder: its logs can make it
   about 1.5 GB.
3. Open the web version, click **Choose your copied folder**, pick that folder and allow editing.
   Then **Scan**, review, tick **I've closed Bambu Studio** and click **Fix selected**. A backup zip
   of the `user` folder goes into `preset-doctor-backups` inside your copy (and you can download
   it).
4. **Copy the repaired files back.** The page lists exactly which files changed: copy each one
   from your copy to the same place inside `%APPDATA%\BambuStudio` and choose **Replace the file
   in the destination**. Don't copy the whole `user` folder back unless you made the copy just
   now and Studio stayed closed since, or it replaces presets you changed in Studio after the copy.

**For OrcaSlicer** the steps are the same with its folder: close OrcaSlicer, paste
`%APPDATA%\OrcaSlicer` into the address bar, and copy only the **`system`** and **`user`** folders
and the **`OrcaSlicer.conf`** file. Don't copy anything else from that folder: it also holds your
sign-in and your printers' access codes, which Preset Doctor doesn't need. The guide on the page
has an **OrcaSlicer** button that shows these steps, and the page tells from the copy which slicer
it is.

![The web version's step-by-step guide](docs/screenshots/web.png)

## How to use it

1. **Close Bambu Studio.** Preset Doctor won't change anything while Studio is running, because
   Studio could overwrite the repair when it saves.
2. **Cloud preset sync can stay on.** The cloud copy of a hidden preset names the same missing
   parent, so Studio skips it and can't undo the repair. The repair usually isn't uploaded on its
   own, though: to get it onto your other computers, open each repaired preset in Studio and save
   it.
   See [the FAQ](#faq) for the details and the one rare exception.
3. **Open Preset Doctor, scan, review, fix.**
   - Click **Scan**. It finds your Bambu Studio folder (`%APPDATA%\BambuStudio`) on its own, or
     your OrcaSlicer folder (`%APPDATA%\OrcaSlicer`) when Bambu Studio isn't installed. With
     both, use the switch at the top.
   - Click a hidden preset to see why it's hidden, the suggested new parent and the exact change.
     If the suggestion looks wrong, pick another candidate or leave that preset alone.
   - Click **Fix selected**. Then open Bambu Studio and check that your presets are back. There
     is no cache to clear: Studio reads the preset files every time it starts.

## Safety

- **Backup first.** Before the first change, it zips your whole `user` folder to
  `%APPDATA%\PresetDoctor\backups\`. **Restore a backup…** at the bottom of the window lists your
  backups; pick one and confirm. Your current presets are backed up first, so a restore can be
  undone too. Each backup remembers which slicer's folder it came from, and is never restored into
  the other slicer's folder.
- **You see every change.** Each repair is shown as a diff before anything is written, and nothing
  is written until you click.
- **Never writes while the slicer is running.** It checks for `bambu-studio.exe` (or
  `orca-slicer.exe` for an OrcaSlicer folder) and refuses if it is running, or if it can't tell
  whether it is.
- **Small, careful edits.** It changes one line per preset and keeps the file's formatting. It
  writes to a temporary file first and then swaps it in, so a crash can't leave a half-written
  preset. If a file changed after the scan, it stops and asks you to scan again.
- **No network.** It makes no network connections of any kind. Your presets never leave your
  computer.
- **Built-in presets are never touched.** Only your own presets under `user\` are changed.

## Command line

The same engine also runs from a terminal, which is handy for checking before you use the app or for
scripting. You need [Node.js 24](https://nodejs.org/) and a clone of this repo:

```sh
git clone https://github.com/smehl86/preset-doctor.git
cd preset-doctor
npm ci
npm run build -w @preset-doctor/core

npm run cli -- scan                 # list presets and problems (reads only)
npm run cli -- scan --type process  # only process presets
npm run cli -- scan --slicer orca   # the OrcaSlicer folder
npm run cli -- fix --dry-run        # show the repairs as diffs (reads only)
npm run cli -- fix --apply --yes    # back up, then repair (close Studio first)
npm run cli -- fix --nozzles --dry-run   # offer filaments on every added nozzle size (diffs)
npm run cli -- backups              # list backups
npm run cli -- backups restore <id> --yes
```

`node packages/core/dist/cli.js <command>` works too. Preset Doctor is not published on npm, so
don't use `npx`. The commands it prints (`preset-doctor fix ...`) are run the same way, as
`npm run cli -- fix ...`. Useful options:

| Option | Meaning |
|---|---|
| `[folder]` | Bambu Studio or OrcaSlicer folder; its files tell which. Default `%APPDATA%\BambuStudio`. |
| `--slicer <bambu\|orca>` | Without a folder: use `%APPDATA%\BambuStudio` or `%APPDATA%\OrcaSlicer`. With a folder: stop (exit 2) if it belongs to the other slicer. |
| `--user <id>` | Which account folder under `user\`. Default: the one with the most presets. |
| `--type <types>` | Only these preset types: `filament`, `process`, `printer` (or `machine`), comma-separated or repeated. Default: all. The `scan` exit code counts only these. |
| `--json` | Machine-readable scan output (always every type; each row has a `type`). |
| `--no-base-id` | Don't update `base_id` in the `.info` sync files. |
| `--nozzles` | `fix` only: instead of repairing, offer filament presets on every nozzle size you've added for their printer. Diffs first; `--apply --yes` writes. |
| `--preset <name>` | With `--nozzles`: only this preset. Can be repeated. |
| `--from-other-folder` | `backups restore` only: put back a backup that was made from a different folder. |
| `--backups <dir>` | Where backups go. Default `%APPDATA%\PresetDoctor\backups`. |

Exit codes: `0` OK, `1` hidden or broken presets found, `2` bad command line, `3` read or write
failure (for `scan`, also: the system presets couldn't be read, so parents weren't checked), `4`
refused for safety (Studio running, files changed during the run, or a backup from another folder).
`fix --apply` makes only the repairs Preset Doctor is confident about. Use the app to pick other
candidates.

## FAQ

**What if it picks the wrong parent?**
Settings you changed yourself (temperatures, flow and so on) stay in your preset. Only the parent
it builds on changes. If the result looks wrong in Studio, close Studio, click **Restore a
backup…** and restore the backup from before the fix (or run
`npm run cli -- backups restore <id> --yes`). Then pick a different candidate, or leave that
preset alone.

**It says "no candidates". Now what?**
Bambu removed or renamed that filament so much that there is no safe guess. The preset is
reported but not changed. You can recreate it in Studio from a similar filament.

**Some presets are "OK, with notes". Should I worry?**
No. Notes cover harmless things, like a missing `.info` sync file or a name that differs from the
file name only in capital letters. Studio still shows those presets.

**Why is my preset under "Unsupported presets"?**
That preset still loads; Studio greys it out because it isn't made for the printer and nozzle you
selected (or for your process preset). Preset Doctor reads which printers you've added in Studio
and tells you which case it is:

- **Unsupported** in the table: the preset is only for printers you haven't added, or for a
  nozzle size you haven't added (for example a 0.8 mm preset when you added only 0.4 and 0.6).
  Add that printer or nozzle in Studio's printer selection, or, if you no longer have it, ignore or
  delete the preset in Studio.
- **A note above the table** ("Some presets are for another printer you've added"): those presets
  are fine. Studio shows them when you select that printer. Click **Show them** to list them.
- **A note "Copies of presets you already use on your printers"**: "Create filament" makes one
  copy of a filament per printer (`<name> @<printer>`), and Studio lists them all under one name,
  `<name>`. When one copy is for a printer you've added, the copies for the other printers only add
  that name, greyed out, under "Unsupported presets". Nothing to do; **Show them** lists them.

Preset Doctor doesn't change which printers these presets are for: add the printer or nozzle in
Studio instead. A process preset that doesn't fit isn't greyed out but left
out of the process list. A preset whose parent is missing doesn't show anywhere, not even under
"Unsupported presets"; that's the one Preset Doctor repairs.

**I made a preset on the 0.4 mm nozzle. Why isn't it there on the 0.6 mm nozzle?**
Studio offers a filament preset only for the nozzle sizes it was made for, and a preset you save
takes that list from the Bambu preset it is based on (for example `Generic PETG @BBL X2D 0.4
nozzle`, which is for the 0.4 mm nozzle only). Preset Doctor can add the other nozzle sizes you've
added for that printer: click **Choose presets…** in the note "Some presets are offered for only
some of your nozzle sizes", or **Offer it on more nozzle sizes…** in a preset's details (command
line: `fix --nozzles`). It adds those printers to the preset's `compatible_printers` list, after a
backup and a review, and changes nothing else. Saving the preset in Studio later keeps the list.
Settings you didn't change yourself still come from the parent made for the original nozzle size;
for Bambu's generic filaments those are the same on every size, but check the max volumetric speed
on a much bigger or smaller nozzle. If you had already made a copy for another nozzle size, both
show there afterwards: delete the one you don't need in Studio.

**Do I need to turn off cloud preset sync?**
No. This comes from Bambu Studio's source code (version 02.09.01.70), and a test in Studio
02.09.01.70 confirmed it: 18 repaired presets stayed after turning sync on and restarting Studio
([SPEC.md §10](SPEC.md#10-open-questions-answer-by-testing-on-the-fixtures-and-in-studio-not-from-research)).
When Studio syncs, a cloud copy whose parent is missing is skipped the same way the local file was,
so it can't put the broken version back. Studio usually doesn't upload a file that was changed
outside it either, so the repair stays on this computer until you open the preset in Studio and
save it. (A preset that was never synced, or still had changes waiting to sync, is the exception:
Studio uploads it on its own once the repair makes it load, which does no harm.)
Turning sync off only postpones syncing, and Studio asks you to turn it back on when you log in.
One rare case: if a repaired preset's cloud copy was deleted (say, from another computer), Studio
may delete the repaired file the next time you log in. Restore it from Preset Doctor's backup.

**Does it work with OrcaSlicer, or on Mac?**
OrcaSlicer, yes (see [Which slicers](#which-slicers)); Mac and Linux, not yet. It supports Bambu
Studio and OrcaSlicer on Windows: filament, process and printer presets.

**OrcaSlicer 2.5 says its built-in presets are "packed". What changes?**
OrcaSlicer 2.5 can ship a vendor's built-in presets as one packed `.opc` file instead of a folder
of `.json` files. Preset Doctor can check that a parent's name is in that file, but can't read its
settings. A preset whose parent is found there is OK; one whose parent isn't is reported as
"Parent could not be checked", never as hidden, and no replacement is suggested for it.

**What are the `user_backup-...` folders in the OrcaSlicer folder?**
OrcaSlicer makes them itself when it updates. Preset Doctor neither reads, backs up nor changes
them.

**Why does a restore of an OrcaSlicer backup leave out some `.info` files?**
For OrcaSlicer, a `.info` sync file whose preset (`.json`) is gone tells OrcaSlicer to delete that
preset from your cloud. A restore therefore puts a `.info` file back only when its preset is in the
backup or still on disk, and says how many it left out.

**What does it change exactly?**
It changes the `inherits` line in the preset's `.json` file. If the preset has a `.info` sync file
with a `base_id` line, it also changes `base_id` to match the new parent, the way Studio writes it
for a freshly created preset. (Studio itself leaves `base_id` as it was when a preset's parent
changes, and only uses it for cloud sync, never to find the parent.) It never touches
`updated_time` or `sync_info`. If a preset's internal name doesn't match its file name, it can
also fix the name (and the matching `filament_settings_id`, `print_settings_id` or
`printer_settings_id`). Offering a filament on more nozzle sizes changes only its
`compatible_printers` list.

## Development

npm workspaces, TypeScript (strict), Vitest, ESLint and Prettier, on Node 24.

```
packages/core/   scan, rules, fixes, backups and the CLI. Pure TypeScript; file access is behind an
                 interface (PresetFs) so tests run in memory. Node-only code is in src/node/.
packages/ui/     the one-screen React UI and the PresetDoctorApi contract it calls as
                 window.presetDoctor. Shared by both apps; AppConfig.platform switches the few
                 web/desktop differences.
apps/desktop/    Electron + React app (electron-vite). The main process runs core; the UI talks
                 to it over a small typed IPC.
apps/web/        Vite + React static site for GitHub Pages. Runs core in the page over a picked
                 folder (File System Access API).
scripts/         fixture generator; r1-simulate.ts and r1-history.ts measure R1's suggestions
                 against a real system profile and against Bambu's profile history
                 (docs/r1-history.md).
```

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run build
npm test                       # unit + fixture tests
npm run test:live              # also scans your real Studio folder, read-only
npm run desktop:dist           # build the portable exe into apps/desktop/release/
npm run desktop:e2e            # desktop end-to-end test on a temp copy of a fixture
npm run web:dev                # web version with hot reload
npm run web:build              # static site into apps/web/dist/
npm run web:e2e                # web end-to-end test in Edge or Chrome
npm run screenshots            # rerun both e2e tests and rewrite docs/screenshots/*.png
```

Why the web version works on a copy: Chromium won't let a web page pick `%APPDATA%` folders at
all (see [SPEC.md §2](SPEC.md#2-step-0-pick-the-form-do-this-first-5-minutes)). The
[Pages workflow](.github/workflows/pages.yml) publishes `apps/web/dist` after CI passes for a push
to `main` (the repo's Pages source must be set to "GitHub Actions"). Releases come from a `v*` tag,
which must match the `version` in every `package.json` (all workspaces share one version).

### Contributing: fixtures

Tests run against real Studio folders in `packages/core/src/__fixtures__/`. When a Studio update
renames presets again, regenerate them from your own install:

```sh
npm run fixtures                         # reads %APPDATA%\BambuStudio
npm run fixtures -- "D:\copy\BambuStudio"  # or a copy of it
```

The script only **reads** the Studio folder. It anonymizes what it copies: account ids become
`1000000001`, `1000000002` and so on, user `setting_id`s get fake values, and `BambuStudio.conf` is
generated from scratch, because the real one holds login tokens and printer serials. It stops if a
real id is left in the output. Still, read the diff before committing, because custom preset
names are copied as they are.

The OrcaSlicer fixture (`__fixtures__/orca/`) comes from `node scripts/make-orca-fixture.ts`,
which copies a small set of built-in presets from `%APPDATA%\OrcaSlicer` (read only) and makes up
the user presets and `OrcaSlicer.conf`; see `__fixtures__/README-orca.md`.

Bug reports: please use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) and include
the `scan --json` output (remove your account id first).

## License and disclaimer

[MIT](LICENSE). Preset Doctor is not affiliated with, endorsed by, or sponsored by Bambu Lab or
the OrcaSlicer project. Bambu Studio and OrcaSlicer are trademarks of their owners.
