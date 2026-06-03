#!/usr/bin/env node
/**
 * Capture a screenshot of every dashboard tab with Playwright. Logs in with the
 * demo password, then walks the tab bar and writes PNGs into docs/screenshots/.
 *
 *   node demo/screenshot.mjs
 *
 * Env:
 *   BASE_URL            default http://localhost:7777
 *   DASHBOARD_PASSWORD  default demo
 *   OUT_DIR             default <repo>/docs/screenshots
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Playwright is installed globally in this environment; fall back to it.
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  const { execSync } = require('node:child_process');
  const globalRoot = execSync('npm root -g').toString().trim();
  ({ chromium } = require(require.resolve('playwright', { paths: [globalRoot] })));
}

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7777';
const PASSWORD = process.env.DASHBOARD_PASSWORD ?? 'demo';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.OUT_DIR ?? join(REPO_ROOT, 'docs', 'screenshots');

const TABS = ['overview', 'sessions', 'vault', 'intelligence', 'graph', 'agents', 'code', 'logs', 'ratelimits'];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 2 });

  // ── Log in ────────────────────────────────────────────────────────────────
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('#password', PASSWORD);
  // The dashboard holds an SSE connection open, so 'networkidle' never fires —
  // wait on the URL settling instead.
  await Promise.all([page.waitForURL('**/dashboard', { waitUntil: 'domcontentloaded' }), page.click('button[type=submit]')]);

  // Let the first SSE tick land so tiles are populated.
  await page.waitForTimeout(2500);

  for (const tab of TABS) {
    const btn = page.locator(`.tab-btn[data-tab="${tab}"]`);
    if (await btn.count() === 0) { console.log(`(skip ${tab} — no tab button)`); continue; }
    await btn.click();
    // Graph needs the force sim to settle; everything else just needs a paint.
    await page.waitForTimeout(tab === 'graph' ? 4000 : 1200);
    // On the Graph tab: reheat for a wider spread, fit the whole graph to the
    // canvas, then click a node to load its note (a plain canvas click loads the
    // side panel without the highlight that would clutter labels).
    if (tab === 'graph') {
      // Reheat for a wider spread, then fit the whole graph to the canvas. No
      // node is selected, so only well-connected hubs are labelled — a clean,
      // readable map rather than an overlapping cluster.
      await page.locator('#graphReheat').click().catch(() => {});
      await page.waitForTimeout(4000);
      await page.locator('#graphFit').click().catch(() => {});
      await page.waitForTimeout(1500);
    }
    // On the Agents tab, pick an agent so the diary feed renders instead of an
    // empty state.
    if (tab === 'agents') {
      const sel = page.locator('#diaryAgentSelect');
      const values = await sel.locator('option').evaluateAll((opts) => opts.map((o) => o.value).filter(Boolean));
      if (values.length) { await sel.selectOption(values[0]); await page.waitForTimeout(1200); }
    }
    const out = join(OUT_DIR, `${tab}.png`);
    await page.screenshot({ path: out, fullPage: true });
    console.log(`✓ ${tab} → ${out}`);
  }

  await browser.close();
}

main().catch((err) => { console.error('Screenshot failed:', err); process.exit(1); });
