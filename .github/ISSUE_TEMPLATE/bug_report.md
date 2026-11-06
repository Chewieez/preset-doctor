---
name: Bug report
about: A preset Preset Doctor got wrong, missed, or couldn't read
title: ''
labels: bug
---

**What happened**
What you expected, and what you saw instead. Screenshots help.

**Versions**
- Preset Doctor version (shown at the bottom of the window, e.g. `v0.1.0`):
- Windows app or web version:
- Bambu Studio version (Help > About):
- System preset version (next to the scan summary, e.g. `02.08.00.06`):
- Windows version:

**Printer and nozzle**
e.g. X1C with 0.4 nozzle, X2D with 0.6 nozzle.

**The preset**
The name of the preset that's wrong. If you can, attach its `.json` file from
`%APPDATA%\BambuStudio\user\<number>\filament\`.

**Scan output**
Windows app or web version: attach a screenshot of the results, with the preset selected so
its details show.

If you work from a clone of the repository, you can paste the full scan instead (it only reads,
it changes nothing). Preset Doctor is not published on npm, so don't use `npx`:

```
npm run build -w @preset-doctor/core
npm run -s cli -- scan --json
```

> **Before pasting or attaching anything, remove your account id.** That's the long number in
> the folder name under `user\` (it also appears as `userId`, `user_id` and in paths). Replace it
> with `1000000001`.

<details><summary>scan --json output</summary>

```json

```

</details>
