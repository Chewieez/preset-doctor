/**
 * End-to-end smoke test of the built web version (run `npm run e2e -w apps/web`).
 *
 * Serves dist/ with `vite preview` and drives it in the installed Edge (or Chrome) with
 * playwright-core. The native folder picker can't be automated, so the page's
 * showDirectoryPicker is replaced with one that returns a folder in the browser's private
 * storage (OPFS), filled with the broken-r1 fixture. That is a real FileSystemDirectoryHandle,
 * so fsaFs, permissions, createWritable and IndexedDB persistence all run for real. Nothing on
 * disk outside the browser's temp profile is touched. With --screenshots (as
 * `npm run screenshots` passes it) it also rewrites docs/screenshots/web*.png.
 *
 * PRESET_DOCTOR_E2E_BROWSER=chrome|msedge picks the browser (default: msedge, then chrome).
 */
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { preview } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const repo = join(appDir, '..', '..');
const fixture = join(repo, 'packages', 'core', 'src', '__fixtures__', 'broken-r1');
const shotsDir = join(repo, 'docs', 'screenshots');
const writeShots = process.argv.includes('--screenshots');
const COPY = 'PresetDoctor-copy';
const ORPHAN = 'user/1000000001/filament/Anycubic Petg 06.json';

async function fixtureFiles(): Promise<{ path: string; base64: string }[]> {
  const out: { path: string; base64: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else {
        out.push({
          path: relative(fixture, abs).split('\\').join('/'),
          base64: (await readFile(abs)).toString('base64'),
        });
      }
    }
  };
  await walk(fixture);
  return out;
}

async function launchBrowser(): Promise<Browser> {
  const wanted = process.env.PRESET_DOCTOR_E2E_BROWSER;
  const channels = wanted ? [wanted] : ['msedge', 'chrome'];
  let lastError: unknown;
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel });
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No Edge or Chrome found for the web e2e test: ${String(lastError)}`);
}

/** Before any page script: the folder picker hands out the OPFS copy instead of a dialog. */
function fakePicker(name: string): void {
  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: async () => (await navigator.storage.getDirectory()).getDirectoryHandle(name),
  });
}

/** Fills the OPFS copy with the fixture, replacing what an earlier run left. */
async function fillCopy(page: Page, files: { path: string; base64: string }[]): Promise<void> {
  await page.evaluate(
    async ({ name, files }) => {
      const opfs = await navigator.storage.getDirectory();
      await opfs.removeEntry(name, { recursive: true }).catch(() => undefined);
      const root = await opfs.getDirectoryHandle(name, { create: true });
      for (const f of files) {
        const parts = f.path.split('/');
        const fileName = parts.pop()!;
        let dir = root;
        for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
        const w = await (await dir.getFileHandle(fileName, { create: true })).createWritable();
        await w.write(Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)));
        await w.close();
      }
    },
    { name: COPY, files },
  );
}

function readCopy(page: Page, path: string): Promise<string | null> {
  return page.evaluate(
    async ({ name, path }) => {
      try {
        let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
        const parts = path.split('/');
        const fileName = parts.pop()!;
        for (const p of parts) dir = await dir.getDirectoryHandle(p);
        return await (await (await dir.getFileHandle(fileName)).getFile()).text();
      } catch {
        return null;
      }
    },
    { name: COPY, path },
  );
}

function listCopy(page: Page, path: string): Promise<string[]> {
  return page.evaluate(
    async ({ name, path }) => {
      try {
        let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
        for (const p of path.split('/')) dir = await dir.getDirectoryHandle(p);
        const out: string[] = [];
        for await (const key of dir.keys()) out.push(key);
        return out.sort();
      } catch {
        return [];
      }
    },
    { name: COPY, path },
  );
}

const rowsWith = (page: Page, status: string) =>
  page.locator(`[data-testid=preset-row][data-status=${status}]`);

async function scanDone(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid=scan-summary]');
  await page.waitForSelector('[data-testid=scan-button]:has-text("Scan again"):not([disabled])');
}

const step = (msg: string): void => console.log(`- ${msg}`);

const files = await fixtureFiles();
if (writeShots) await mkdir(shotsDir, { recursive: true });
const server = await preview({
  root: appDir,
  configFile: join(appDir, 'vite.config.ts'),
  preview: { port: 4317, strictPort: false, host: '127.0.0.1', open: false },
  logLevel: 'warn',
});
const base = server.resolvedUrls?.local[0];
let browser: Browser | null = null;

try {
  assert.ok(base, 'preview server URL');
  // Use "localhost": a secure context, like https on GitHub Pages.
  const url = base.replace('127.0.0.1', 'localhost');
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addInitScript(fakePicker, COPY);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.emulateMedia({ colorScheme: 'light' });

  const foreign: string[] = [];
  const cspErrors: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(url) && !r.url().startsWith('blob:') && !r.url().startsWith('data:'))
      foreign.push(r.url());
  });
  page.on('console', (m) => {
    if (m.type() === 'error') cspErrors.push(m.text());
  });

  step('Guide first, nothing picked');
  await page.goto(url);
  await page.waitForSelector('[data-testid=web-guide]');
  assert.equal(await page.isDisabled('[data-testid=scan-button]'), true);
  assert.equal(
    await page.getAttribute('[data-testid=desktop-app-link]', 'href'),
    'https://github.com/shmehltr/preset-doctor/releases',
  );
  if (writeShots) {
    await page.screenshot({ path: join(shotsDir, 'web.png') });
    console.log('  screenshot docs/screenshots/web.png');
  }

  step("The guide switches to OrcaSlicer's folder and files");
  {
    const guide = page.locator('[data-testid=web-guide]');
    await page.click('[data-testid=guide-slicer-orca]');
    const text = (await guide.textContent()) ?? '';
    assert.match(text, /%APPDATA%\\OrcaSlicer/);
    assert.match(text, /OrcaSlicer\.conf/);
    assert.doesNotMatch(text, /BambuStudio/);
    await page.click('[data-testid=guide-slicer-bambu]');
    assert.match((await guide.textContent()) ?? '', /BambuStudio\.conf/);
  }

  step('Pick the copy, scan');
  await fillCopy(page, files);
  await page.click('[data-testid=guide-pick]');
  await scanDone(page);
  assert.equal(await page.textContent('[data-testid=root-path]'), COPY);
  const hiddenBefore = await rowsWith(page, 'hidden').count();
  console.log(`  ${hiddenBefore} hidden presets`);
  assert.equal(hiddenBefore, 22);

  step('A short window scrolls; the table never runs under the fix bar or footer');
  for (const height of [420, 560, 700]) {
    await page.setViewportSize({ width: 1400, height });
    const box = async (sel: string) => {
      const b = await page.locator(sel).first().boundingBox();
      assert.ok(b, `${sel} is on the page`);
      return b;
    };
    // boundingBox is in page coordinates, so scrolling doesn't change the order.
    const split = await box('.split');
    const fixbar = await box('[data-testid=fixbar]');
    const footer = await box('.footer');
    assert.ok(split.height >= 299, `table area keeps its minimum height at ${height}px`);
    assert.ok(
      split.y + split.height <= fixbar.y + 0.5,
      `table ends above the fix bar at ${height}px`,
    );
    assert.ok(
      fixbar.y + fixbar.height <= footer.y + 0.5,
      `fix bar ends above the footer at ${height}px`,
    );
  }
  await page.setViewportSize({ width: 1400, height: 900 });

  step('Fix stays off until "I\'ve closed Bambu Studio" is ticked');
  assert.equal(await page.isDisabled('[data-testid=fix-selected]'), true);
  assert.match((await page.textContent('[data-testid=fix-blocked-reason]')) ?? '', /tick the box/);
  await page.check('[data-testid=studio-confirm] input');
  assert.equal(await page.isDisabled('[data-testid=fix-selected]'), false);

  step('Review and repair');
  await page.click('[data-testid=fix-selected]');
  const dialog = page.locator('[data-testid=review-dialog]');
  await dialog.locator('[data-testid=diff]').first().waitFor();
  await page.click('[data-testid=confirm-apply]');
  await page.locator('[data-testid=result-banner]', { hasText: 'Repaired' }).waitFor();
  await scanDone(page);
  const changed = (await page.locator('[data-testid=changed-files] li').allTextContents()).sort();
  console.log(`  ${changed.length} files to copy back`);
  assert.ok(changed.includes(ORPHAN.split('/').join('\\')), 'orphan listed for copy-back');
  assert.ok(changed.every((f) => f.startsWith('user\\1000000001\\')));
  assert.equal(
    await rowsWith(page, 'hidden').count(),
    3,
    'no-candidates, low-only and unsure-nozzle stay hidden',
  );
  assert.match((await readCopy(page, ORPHAN)) ?? '', /"inherits": "Generic PETG @BBL X2D",/);
  const zips = (await listCopy(page, 'preset-doctor-backups')).filter((f) => f.endsWith('.zip'));
  console.log(`  backups: ${zips.join(', ')}`);
  assert.equal(zips.length, 1, 'one backup zip before the first write');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-testid=download-notice-backup]'),
  ]);
  assert.equal(download.suggestedFilename(), `preset-doctor-backup-${zips[0]}`);
  if (writeShots) {
    await page.screenshot({ path: join(shotsDir, 'web-fixed.png') });
    console.log('  screenshot docs/screenshots/web-fixed.png');
  }

  step('The folder is remembered after a reload');
  await page.reload();
  await page.waitForSelector('[data-testid=scan-button]:not([disabled])');
  assert.equal(await page.textContent('[data-testid=root-path]'), COPY);
  await page.click('[data-testid=scan-button]');
  await scanDone(page);
  assert.equal(await rowsWith(page, 'hidden').count(), 3);

  step('Restore needs the checkbox too, then puts the presets back');
  await page.click('[data-testid=open-backups]');
  const list = page.locator('[data-testid=backup-list] li');
  await list.first().waitFor();
  assert.equal(await list.first().locator('button:has-text("Restore")').isDisabled(), true);
  await page.check('[data-testid=backups-dialog] [data-testid=studio-confirm] input');
  await list.first().locator('button:has-text("Restore")').click();
  await list.first().locator('button:has-text("Yes, restore")').click();
  await page.locator('[data-testid=result-banner]', { hasText: 'Restored' }).waitFor();
  await scanDone(page);
  assert.equal(await rowsWith(page, 'hidden').count(), hiddenBefore);
  const original = await readFile(join(fixture, ...ORPHAN.split('/')), 'utf8');
  assert.equal(await readCopy(page, ORPHAN), original);

  step('A browser without folder access gets a friendly message');
  const plain = await browser.newContext();
  await plain.addInitScript(() => {
    delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    delete (Window.prototype as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
  const other = await plain.newPage();
  await other.goto(url);
  await other.waitForSelector('[data-testid=unsupported-browser]');
  await plain.close();

  assert.deepEqual(foreign, [], 'no requests to other origins');
  assert.deepEqual(
    cspErrors.filter((e) => /Content Security Policy/i.test(e)),
    [],
    'no CSP violations',
  );
  console.log('Web E2E smoke test passed.');
} catch (err) {
  console.error('Web E2E smoke test FAILED:', err);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await server.close();
}
