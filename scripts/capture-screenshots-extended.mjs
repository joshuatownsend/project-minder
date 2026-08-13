// Captures the 25 "new feature" screenshots for the GitHub Pages refresh.
// Pairs with capture-screenshots.mjs (which handles the original landing-page set)
// and capture-agents-skills.mjs (which handles agents/skills/provenance).
//
// Run with the dev server already running on http://localhost:4100 — or set
// MINDER_CAPTURE_BASE to point at a prod-built server on a different port
// (used by scripts/capture-screenshots-prod.mjs).
// All output lands in site/screenshots/.

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.MINDER_CAPTURE_BASE || 'http://localhost:4100';
// MINDER_CAPTURE_OUT lets the demo pass write to a temp dir instead of the live
// screenshot directory; MINDER_CAPTURE_DPR=2 is the resolution fix (see
// capture-screenshots.mjs for the rationale).
const OUT  = process.env.MINDER_CAPTURE_OUT || join(__dirname, '..', 'site', 'screenshots');
const DPR = Number(process.env.MINDER_CAPTURE_DPR || 2);
// Nav timeout. 90s was too tight against a real index: /usage aggregates
// thousands of sessions server-side and blew that budget. The deck script
// already runs at 180s for the same reason.
const NAV_TIMEOUT = Number(process.env.MINDER_CAPTURE_NAV_TIMEOUT || 180000);

// Demo mode has no `project-minder` (that route renders "Project not found"),
// so the demo pass points the per-project shots at a fixture project instead.
const PROJECT = process.env.MINDER_CAPTURE_PROJECT || 'project-minder';

mkdirSync(OUT, { recursive: true });

// Same per-shot isolation as capture-screenshots.mjs: 25 shots in a row means
// one slow route would otherwise discard every capture after it.
const failures = [];
// A failed navigation leaves the browser on the PREVIOUS route, so shooting
// afterwards writes the wrong page under the new name — worse than no shot.
let lastNavOk = true;


// Chromium renders its own error page ("This page couldn't load") as a
// SUCCESSFUL navigation, so a nav-ok check does not catch a crashed renderer.
// See capture-screenshots.mjs — this shipped a browser error page as a
// published screenshot on 2026-08-12.
async function pageIsHealthy(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body.innerText || '';
      if (/This page couldn.t load|site can.t be reached|Aw, Snap|ERR_[A-Z_]{3,}/i.test(text)) {
        return false;
      }
      return document.querySelectorAll('a').length > 0;
    });
  } catch {
    return false;
  }
}

async function shoot(page, name, { selector } = {}) {
  if (!lastNavOk) {
    console.warn(`  ⚠  ${name}.png skipped — its page failed to load`);
    failures.push(name);
    return;
  }
  if (!(await pageIsHealthy(page))) {
    console.warn(`  ⚠  ${name}.png skipped — the browser is showing an error page, not the app`);
    failures.push(name);
    return;
  }
  const dest = join(OUT, `${name}.png`);
  // 120s timeout absorbs slow font/asset loads on heavy routes (/agent-view,
  // /stats), now doubled from 60s because a 2x raster is 4x the pixels.
  // `animations: disabled` stops a continuously-polling panel from holding the
  // screenshot open while Playwright waits for animations to settle.
  const opts = { path: dest, timeout: 120000, animations: 'disabled', caret: 'hide' };
  try {
    if (selector) {
      const el = await page.waitForSelector(selector, { timeout: 5000 });
      await el.screenshot(opts);
    } else {
      await page.screenshot({ ...opts, fullPage: false });
    }
    console.log(`  ✓  ${name}.png`);
  } catch (err) {
    console.warn(`  ⚠  ${name}.png failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    failures.push(name);
  }
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
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    lastNavOk = true;
  } catch (err) {
    lastNavOk = false;
    console.warn(`  ⚠  navigation to ${route} failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    return false;
  }
  await page.waitForTimeout(settle);
  await waitForStableUI(page, { timeout: stableTimeout });
  await page.waitForTimeout(postSettle);
  return true;
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
  const ctx     = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR });
  const page    = await ctx.newPage();

  // Fetch first session ID for the session-quality shots.
  // 180s timeout — cold parse of all session JSONL files can be slow, and 90s
  // was measured as too short against a ~6,000-session index. This path only
  // warns on failure, so an over-tight timeout does not fail the run; it
  // silently drops session-replay-scrubber and session-diagnosis instead.
  console.log('Fetching first session ID for session-detail captures...');
  let firstSessionId = null;
  try {
    // Use the API request context, NOT page.goto + response.json(). Reading a
    // navigation response body goes through the DevTools protocol, and this
    // endpoint's payload is large enough to be dropped from that buffer before
    // we read it — "Request content was evicted from inspector cache", which
    // silently cost both session shots a refresh on 2026-08-12.
    const resp = await page.request.get(`${BASE}/api/sessions`, { timeout: 180000 });
    if (resp.ok()) {
      const sessions = await resp.json();
      firstSessionId = sessions[0]?.sessionId ?? null;
    } else {
      console.warn(`  ⚠  /api/sessions returned ${resp.status()}`);
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
  await go(page, `/project/${PROJECT}?tab=config-lint`, 1200);
  await shoot(page, 'config-linter');

  // MCP tab on global Config browser, with security findings
  await go(page, '/config?type=mcp', 1200);
  await shoot(page, 'mcp-security');

  // Config history tab on project detail
  await go(page, `/project/${PROJECT}?tab=config-history`, 1000);
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

  if (failures.length) {
    console.error(
      `✗ ${failures.length} published shot(s) failed: ${failures.join(', ')}\n` +
      '  site/index.html references these, so the page still shows their previous version.',
    );
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('\n✗ capture-screenshots-extended failed:', err);
  process.exit(1);
});
