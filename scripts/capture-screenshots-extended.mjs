// Captures the 25 "new feature" screenshots for the GitHub Pages refresh.
// Pairs with capture-screenshots.mjs (which handles the original landing-page set)
// and capture-agents-skills.mjs (which handles agents/skills/provenance).
//
// Run with the dev server already running on http://localhost:4100.
// All output lands in site/screenshots/.

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:4100';
const OUT  = join(__dirname, '..', 'site', 'screenshots');

mkdirSync(OUT, { recursive: true });

async function shoot(page, name, { selector } = {}) {
  const dest = join(OUT, `${name}.png`);
  // 60s timeout absorbs slow font/asset loads on heavy routes (/agent-view, /stats).
  const opts = { path: dest, timeout: 90000 };
  if (selector) {
    const el = await page.waitForSelector(selector, { timeout: 5000 });
    await el.screenshot(opts);
  } else {
    await page.screenshot({ ...opts, fullPage: false });
  }
  console.log(`  ✓  ${name}.png`);
}

// Wait until both the Next.js dev "Compiling…" pill and Tailwind's
// .animate-pulse skeleton placeholders have been gone for ~1.5s sustained.
// We run the check via waitForFunction (page-context JS, Playwright-enforced
// timeout) instead of locator polling — keeps the whole wait bounded and
// avoids the locator.count() hang we hit on stubborn pages.
async function waitForStableUI(page, { timeout = 25000 } = {}) {
  try {
    await page.waitForFunction(
      () => {
        const w = /** @type {any} */ (window);
        const now = Date.now();
        const hasCompile = /Compiling/i.test(document.body.innerText || '');
        const hasSkeleton = document.querySelectorAll('.animate-pulse').length > 0;
        if (hasCompile || hasSkeleton) {
          w.__minderQuietSince = null;
          return false;
        }
        if (!w.__minderQuietSince) {
          w.__minderQuietSince = now;
          return false;
        }
        return now - w.__minderQuietSince >= 1500;
      },
      null,
      { timeout, polling: 250 },
    );
  } catch {
    // Stability not achieved within timeout — accept whatever's on screen.
  }
}

async function go(page, route, settle = 800, { stableTimeout = 60000, postSettle = 4000 } = {}) {
  // domcontentloaded + settle is more reliable than networkidle for this app:
  // background polling (git status, sessions, OTEL) keeps the network busy
  // and would otherwise time out the 30s networkidle wait.
  // 90s nav timeout absorbs Next.js dev's first-compile cost; 60s stability
  // timeout absorbs the data-fetch cost on heavy routes.
  //
  // postSettle (default 4s) is the safety net for pages that DON'T use the
  // Skeleton component (e.g. /usage renders empty stat cards until data
  // arrives via /api/usage which takes ~5s in dev). waitForStableUI returns
  // instantly when no skeleton is ever shown, so we always wait a final
  // window for data fetches to complete.
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(settle);
  await waitForStableUI(page, { timeout: stableTimeout });
  await page.waitForTimeout(postSettle);
}

// Click a navigation button by visible text. The Settings page uses a sidebar
// <nav> with <button><span>Label</span></button> entries — getByRole alone
// can return a different button on the page that happens to share the name,
// so we scope to nav-button-with-text first. Falls back through getByRole
// and getByText. Silently swallows missing elements.
async function clickButton(page, name) {
  const label = typeof name === 'string' ? name : name.source;
  const text = typeof name === 'string' ? name : name.source.replace(/^\^|\$$/g, '');

  const candidates = [
    page.locator(`nav button:has-text("${text}")`),
    page.locator(`button:has-text("${text}")`),
    page.getByRole('button', { name }),
    page.getByText(name, { exact: false }),
  ];

  for (const loc of candidates) {
    try {
      await loc.first().click({ timeout: 2500 });
      await page.waitForTimeout(400);
      return;
    } catch {
      // try next strategy
    }
  }
  console.warn(`  ⚠  could not click "${label}" — capturing current view`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page    = await ctx.newPage();

  // Fetch first session ID for the session-quality shots.
  // 90s timeout — cold parse of all session JSONL files can be slow.
  console.log('Fetching first session ID for session-detail captures...');
  let firstSessionId = null;
  try {
    const resp = await page.goto(`${BASE}/api/sessions`, { timeout: 90000 });
    if (resp?.ok()) {
      const sessions = await resp.json();
      firstSessionId = sessions[0]?.sessionId ?? null;
    }
  } catch (err) {
    console.warn(`  ⚠  /api/sessions error: ${err.message}`);
  }
  if (!firstSessionId) {
    console.warn('  ⚠  No sessions found — session-replay-scrubber + session-diagnosis will be skipped');
  }

  console.log('\nCapturing 25 new screenshots...\n');

  // ── Memory Observatory ────────────────────────────────────
  console.log('Memory Observatory:');
  await go(page, '/memory', 1200);
  await shoot(page, 'memory-observatory');

  await go(page, '/memory/seed', 1000);
  await shoot(page, 'memory-seed');

  await go(page, '/memory/triage', 1000);
  await shoot(page, 'memory-triage');

  // ── Multi-Agent Coordination ──────────────────────────────
  console.log('\nMulti-Agent:');
  await go(page, '/agent-view', 1200);
  await shoot(page, 'agent-view');

  await go(page, '/kanban', 1200);
  await shoot(page, 'kanban');

  await go(page, '/tasks', 1000);
  await shoot(page, 'tasks');

  await go(page, '/swarms', 1000);
  await shoot(page, 'swarms');

  // ── Templates & Library ───────────────────────────────────
  console.log('\nTemplates & Library:');
  await go(page, '/templates', 1000);
  await shoot(page, 'templates');

  await go(page, '/library', 1200);
  await shoot(page, 'library');

  await go(page, '/new-project', 1000);
  await shoot(page, 'new-project-wizard');

  // ── Config Linting & Security ─────────────────────────────
  console.log('\nConfig Lint & Security:');
  // ConfigLintPanel lives on project detail under ?tab=config-lint
  await go(page, '/project/project-minder?tab=config-lint', 1200);
  await shoot(page, 'config-linter');

  // MCP tab on global Config browser, with security findings
  await go(page, '/config?type=mcp', 1200);
  await shoot(page, 'mcp-security');

  // Config history tab on project detail
  await go(page, '/project/project-minder?tab=config-history', 1000);
  await shoot(page, 'config-history');

  // ── Session Quality & Diagnosis ───────────────────────────
  console.log('\nSession Quality:');
  if (firstSessionId) {
    // Timeline with replay scrubber + retry-cycle highlights (default tab)
    await go(page, `/sessions/${firstSessionId}`, 2500);
    await shoot(page, 'session-replay-scrubber');

    // Diagnosis tab — use locator with :has-text() for direct text match
    // (getByRole + regex was returning empty even with TabBar rendered).
    try {
      await page.locator('button:has-text("Diagnosis")').first().click({ timeout: 5000 });
      await page.waitForTimeout(600);
    } catch {
      console.warn('  ⚠  could not click Diagnosis tab — capturing current view');
    }
    await shoot(page, 'session-diagnosis');
  } else {
    console.log('  (skipping session-replay-scrubber + session-diagnosis: no sessions)');
  }

  // Skipped: a dedicated `self-correction.png` shot was attempted from /usage
  // scrolled to the per-model breakdown, but the inline "self-corr" rate only
  // renders when there's enough telemetry to compute it. The existing
  // usage-dashboard.png shot already covers the /usage page comprehensively,
  // so this dedicated shot was dropped from the landing page.

  // ── Notifications, Budgets, Adapters (single /settings visit) ────
  console.log('\nNotifications + Settings tabs:');
  await go(page, '/settings', 2000);
  await clickButton(page, 'Notifications');
  await shoot(page, 'notifications');

  await clickButton(page, 'Cost');
  await shoot(page, 'settings-cost-cap');

  await clickButton(page, 'Adapters');
  await shoot(page, 'settings-adapters');

  // ── Power-User Tools ──────────────────────────────────────
  console.log('\nPower Tools:');
  await go(page, '/commands', 1200);
  await shoot(page, 'commands');

  await go(page, '/sql', 1000);
  await shoot(page, 'sql');

  await go(page, '/plans', 1000);
  await shoot(page, 'plans');

  await go(page, '/schedule', 1000);
  await shoot(page, 'schedule');

  await go(page, '/health', 1000);
  await shoot(page, 'health');

  await go(page, '/insights-report', 1500);
  await shoot(page, 'insights-report');

  await browser.close();
  console.log(`\nAll new screenshots saved to:\n  ${OUT}\n`);
})();
