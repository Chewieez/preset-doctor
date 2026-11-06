/**
 * End-to-end smoke test of the built app (run `npm run e2e -w apps/desktop`).
 *
 * Works on a temp copy of the broken-r1 fixture, never on the real Bambu Studio folder: the app is
 * started with PRESET_DOCTOR_ROOT pointing at the copy and a faked "is Studio running" answer
 * (the real Studio may well be open on this machine). With --screenshots (as
 * `npm run screenshots` passes it) it also rewrites the README screenshots in docs/screenshots.
 *
 * Set PRESET_DOCTOR_E2E_KEEP=1 to keep the temp folder for inspection, and
 * PRESET_DOCTOR_E2E_EXE to a packaged exe (release/win-unpacked/Preset Doctor.exe) to test that
 * instead of the out/ build.
 */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const repo = join(appDir, '..', '..');
const fixture = join(repo, 'packages', 'core', 'src', '__fixtures__', 'broken-r1');
const shotsDir = join(repo, 'docs', 'screenshots');
const writeShots = process.argv.includes('--screenshots');
const packagedExe = process.env.PRESET_DOCTOR_E2E_EXE;
const electronPath = packagedExe ?? (createRequire(import.meta.url)('electron') as string);

// What the README screenshots show instead of the temp folder (which contains the user name).
const SHOWN_ROOT = 'C:\\Users\\you\\AppData\\Roaming\\BambuStudio';
const ORPHAN = 'Anycubic Petg 06';
const LOW_ONLY = 'Synthetic Other Printer Only';
const UNSURE_NOZZLE = 'Synthetic Stripped Suffix';
const NO_CANDIDATES = 'Synthetic No Candidates';

const work = await mkdtemp(join(tmpdir(), 'preset-doctor-e2e-'));
const root = join(work, 'BambuStudio');
const backups = join(work, 'backups');
await cp(fixture, root, { recursive: true });
if (writeShots) await mkdir(shotsDir, { recursive: true });

const launched: ElectronApplication[] = [];

async function launch(studioRunning: '0' | '1'): Promise<ElectronApplication> {
  const app = await electron.launch({
    executablePath: electronPath,
    args: packagedExe ? [] : [appDir],
    cwd: appDir,
    env: {
      ...process.env,
      PRESET_DOCTOR_ROOT: root,
      PRESET_DOCTOR_BACKUPS: backups,
      PRESET_DOCTOR_FAKE_STUDIO_RUNNING: studioRunning,
      PRESET_DOCTOR_USER_DATA: join(work, 'user-data'),
    },
  });
  launched.push(app);
  return app;
}

async function openWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  // A fixed size, so screenshots don't depend on this machine's screen.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1400, 900));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForSelector('[data-testid=scan-button]:not([disabled])');
  return page;
}

async function scan(page: Page): Promise<void> {
  await page.click('[data-testid=scan-button]');
  await page.waitForSelector('[data-testid=scan-summary]');
  await page.waitForSelector('[data-testid=scan-button]:has-text("Scan again"):not([disabled])');
}

const rowsWith = (page: Page, status: string) =>
  page.locator(`[data-testid=preset-row][data-status=${status}]`);
const row = (page: Page, name: string) =>
  page.locator('[data-testid=preset-row]', { has: page.locator('.name', { hasText: name }) });

async function screenshot(page: Page, file: string): Promise<void> {
  // The README shows a normal run: the real folder name, and no test-mode banner.
  await page.evaluate((shown) => {
    const el = document.querySelector('[data-testid=root-path]');
    if (el) el.textContent = shown;
    document.querySelector<HTMLElement>('[data-testid=test-mode-banner]')?.remove();
  }, SHOWN_ROOT);
  const text = await page.evaluate(() => document.body.innerText);
  assert.ok(!text.includes(work), `the temp folder (with the user name) shows in ${file}`);
  // The check above runs either way; only the file is optional.
  if (!writeShots) return;
  await page.screenshot({ path: join(shotsDir, file) });
  console.log(`  screenshot docs/screenshots/${file}`);
}

const step = (msg: string): void => console.log(`- ${msg}`);

try {
  step('Studio "running": repairs are blocked');
  {
    const app = await launch('1');
    const page = await openWindow(app);
    await page.waitForSelector('[data-testid=studio-pill].studio-running');
    await scan(page);
    assert.ok((await rowsWith(page, 'hidden').count()) > 0, 'expected hidden presets');
    assert.equal(await page.isDisabled('[data-testid=fix-selected]'), true);
    const reason = await page.textContent('[data-testid=fix-blocked-reason]');
    assert.match(reason ?? '', /Close Bambu Studio/);
    await app.close();
  }

  step('Studio closed: scan, review, repair');
  const app = await launch('0');
  const page = await openWindow(app);
  await page.waitForSelector('[data-testid=studio-pill].studio-closed');
  await scan(page);

  const hiddenBefore = await rowsWith(page, 'hidden').count();
  console.log(`  ${hiddenBefore} hidden presets`);
  assert.equal(hiddenBefore, 22);
  assert.equal(await page.isVisible('[data-testid=cloud-banner]'), true, 'cloud sync banner');
  assert.equal(await page.isVisible('[data-testid=test-mode-banner]'), true, 'test mode banner');

  await row(page, ORPHAN).click();
  const detail = page.locator('[data-testid=detail-panel]');
  await detail.locator('.candidate.chosen', { hasText: 'Generic PETG @BBL X2D' }).waitFor();
  await detail
    .locator('.diff-line.add', { hasText: '"inherits": "Generic PETG @BBL X2D",' })
    .waitFor();
  await screenshot(page, 'before.png');

  // A preset with only low-confidence candidates is not pre-selected; pick one by hand.
  await row(page, LOW_ONLY).click();
  assert.equal(await row(page, LOW_ONLY).locator('input[type=checkbox]').isDisabled(), true);
  await detail.locator('.candidate input[type=radio]').first().check();
  assert.equal(await row(page, LOW_ONLY).locator('input[type=checkbox]').isChecked(), true);
  await detail.locator('[data-testid=diff]').first().waitFor();

  // Nor is one whose parent's name has no nozzle size: pick the 0.4 nozzle preset by hand.
  await row(page, UNSURE_NOZZLE).click();
  assert.equal(await row(page, UNSURE_NOZZLE).locator('input[type=checkbox]').isChecked(), false);
  await detail
    .locator('.candidate', { hasText: 'Bambu PLA Basic @BBL X2D 0.4 nozzle' })
    .locator('input[type=radio]')
    .check();
  assert.equal(await row(page, UNSURE_NOZZLE).locator('input[type=checkbox]').isChecked(), true);

  await page.click('[data-testid=fix-selected]');
  const dialog = page.locator('[data-testid=review-dialog]');
  await dialog.locator('[data-testid=diff]').first().waitFor();
  const planned = await dialog.locator('[data-testid=diff]').count();
  console.log(`  ${planned} file changes planned`);
  await page.click('[data-testid=confirm-apply]');
  await page.locator('[data-testid=result-banner]', { hasText: 'Repaired' }).waitFor();
  await page.waitForSelector('[data-testid=scan-button]:has-text("Scan again"):not([disabled])');

  step('Rescan is clean');
  const hiddenAfter = rowsWith(page, 'hidden');
  assert.equal(await hiddenAfter.count(), 1, 'only the preset with no candidates stays hidden');
  assert.match((await hiddenAfter.first().textContent()) ?? '', new RegExp(NO_CANDIDATES));
  assert.equal(await rowsWith(page, 'broken').count(), 0);
  await page.click('.table-tools button:has-text("All presets")');
  await row(page, ORPHAN).click();
  await screenshot(page, 'after.png');

  const fixed = await readFile(
    join(root, 'user', '1000000001', 'filament', `${ORPHAN}.json`),
    'utf8',
  );
  assert.match(fixed, /"inherits": "Generic PETG @BBL X2D",/);

  const zips = (await readdir(backups)).filter((f) => f.endsWith('.zip'));
  console.log(`  backups: ${zips.join(', ')}`);
  assert.equal(zips.length, 1, 'one backup zip before the first write');

  step('Restore puts the presets back');
  await page.click('[data-testid=open-backups]');
  const list = page.locator('[data-testid=backup-list] li');
  await list.first().waitFor();
  assert.equal(await list.count(), 1);
  await list.first().locator('button:has-text("Restore")').click();
  await list.first().locator('button:has-text("Yes, restore")').click();
  await page.locator('[data-testid=result-banner]', { hasText: 'Restored' }).waitFor();
  await page.waitForSelector('[data-testid=scan-button]:has-text("Scan again"):not([disabled])');
  assert.equal(await rowsWith(page, 'hidden').count(), hiddenBefore);
  const restored = await readFile(
    join(root, 'user', '1000000001', 'filament', `${ORPHAN}.json`),
    'utf8',
  );
  const original = await readFile(
    join(fixture, 'user', '1000000001', 'filament', `${ORPHAN}.json`),
    'utf8',
  );
  assert.equal(restored, original);

  await app.close();
  console.log('E2E smoke test passed.');
} catch (err) {
  console.error('E2E smoke test FAILED:', err);
  process.exitCode = 1;
} finally {
  for (const app of launched) await app.close().catch(() => undefined);
  if (process.env.PRESET_DOCTOR_E2E_KEEP === '1') {
    console.log(`Kept ${work}`);
  } else {
    // Electron may hold its cache files for a moment after closing.
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(
      (e: unknown) => console.warn(`Could not remove ${work}: ${String(e)}`),
    );
  }
}
