/**
 * Measures R1 candidate ranking against a real system profile.
 *
 *   node scripts/r1-simulate.ts [<BambuStudio folder>] [--json] [--list-wrong]
 *                                         (default folder: %APPDATA%\BambuStudio)
 *
 * The folder is only read: its system presets are copied into memory once and every scenario
 * runs on that copy. Nothing is written anywhere. The scenarios are described in
 * packages/core/src/testing/r1Simulation.ts (shared with the PRESET_DOCTOR_LIVE test).
 *
 * Columns per run: high-preselected-correct, high-preselected-WRONG, high-not-preselected
 * (several equally good, the user picks), medium-only (with how many list a right fix first),
 * none (only other printers, or nothing). Also prints how the account sidecars' base_id compares
 * with each preset's own parent (counts only). Then the same for process and printer presets
 * (packages/core/src/testing/r1TypeSimulation.ts): a process pick is right when it keeps the
 * layer height and every printer, and a printer pick is always wrong (the user picks the printer).
 * Exits 1 if any pre-selection is wrong.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Core's sources import each other as './x.js' (for tsc); point those at the .ts files so
// Node's type stripping can run them directly.
const coreSrc = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'core', 'src') +
    path.sep,
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(coreSrc) && /^\.\.?\/.*\.js$/.test(specifier)) {
      const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
    return next(specifier, context);
  },
});

// Imported after the hook is in place.
const sim = await import('../packages/core/src/testing/r1Simulation.ts');
const typeSim = await import('../packages/core/src/testing/r1TypeSimulation.ts');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const studioRoot = path.resolve(
  args.find((a) => !a.startsWith('--')) ?? path.join(process.env['APPDATA'] ?? '', 'BambuStudio'),
);
if (!existsSync(path.join(studioRoot, 'system', 'BBL.json'))) {
  console.error(`Not a Bambu Studio folder (no system/BBL.json): ${studioRoot}`);
  process.exit(2);
}

const system = await sim.loadSystemCopy(studioRoot);
const result = await sim.simulateR1(system);
const sidecars = await sim.measureSidecars(studioRoot, system);
const process_ = await typeSim.simulateR1Process(await typeSim.loadTypeCopy(studioRoot, 'process'));
const machine = await typeSim.simulateR1Machine(await typeSim.loadTypeCopy(studioRoot, 'machine'));
const wrong = result.wrong.length + process_.wrong.length + machine.wrong.length;

if (flags.has('--json')) {
  console.log(JSON.stringify({ ...result, sidecars, process: process_, machine }, null, 2));
} else {
  console.log(`System profile ${result.version ?? '(unknown)'}, ${result.scenarios} scenarios\n`);
  const head = [
    'scenario'.padEnd(44),
    'high-correct',
    'high-WRONG',
    'high-unsel',
    'medium-only (right first)',
    'none',
  ];
  console.log(head.join(' | '));
  console.log(head.map((h) => '-'.repeat(h.length)).join('-|-'));
  for (const r of result.rows) {
    const label =
      `${r.kind.padEnd(7)} ${r.mode.padEnd(10)} ` +
      `compat=${r.compat ? 'yes' : 'no '} base_id=${r.baseId ? 'yes' : 'no '}`;
    const medium = `${r.counts.medium} (${r.mediumTopRight})`;
    const cells = [r.counts.correct, r.counts.wrong, r.counts.unselected, medium, r.counts.none];
    console.log(
      [label.padEnd(44), ...cells.map((c, i) => String(c).padStart(head[i + 1]!.length))].join(
        ' | ',
      ),
    );
  }
  console.log(`\nWRONG pre-selections: ${result.wrong.length}`);
  if (flags.has('--list-wrong')) for (const w of result.wrong) console.log(`  ${w}`);
  const s = sidecars;
  console.log(
    `\nSidecar base_id vs the preset's own system parent (${s.checked} sidecars): ` +
      `same preset ${s.sameParent}, same filament and printer but another nozzle ` +
      `${s.sameStemAndPrinterOtherNozzle}, another printer ${s.otherPrinter}, another filament ` +
      `${s.otherStem}, not a system preset ${s.notSystem}.`,
  );
  for (const t of [process_, machine]) {
    const name = t === machine ? 'Printer' : 'Process';
    console.log(`\n${name} presets: ${t.scenarios} scenarios\n`);
    const tHead = [
      'scenario'.padEnd(24),
      'high-correct',
      'high-WRONG',
      'high-unsel',
      'medium-only',
      'none',
    ];
    console.log(tHead.join(' | '));
    console.log(tHead.map((h) => '-'.repeat(h.length)).join('-|-'));
    for (const r of t.rows) {
      const label = `${r.kind.padEnd(7)} base_id=${r.baseId ? 'yes' : 'no '}`;
      const cells = [
        r.counts.correct,
        r.counts.wrong,
        r.counts.unselected,
        r.counts.medium,
        r.counts.none,
      ];
      console.log(
        [label.padEnd(24), ...cells.map((c, i) => String(c).padStart(tHead[i + 1]!.length))].join(
          ' | ',
        ),
      );
    }
    console.log(`\nWRONG pre-selections: ${t.wrong.length}`);
    if (flags.has('--list-wrong')) for (const w of t.wrong) console.log(`  ${w}`);
  }
}
process.exitCode = wrong > 0 ? 1 : 0;
