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
// Shots another pass owns, or that a targeted re-run wants to leave alone.
// None of this file's shots are in the hybrid orchestrator's DEMO_OWNED list,
// so this started as a deliberate exemption — but re-shooting ONE image without
// re-running all 24 turned out to matter a great deal while fixing loading-state
// captures, and MINDER_CAPTURE_ONLY is the cheap way to get it.
const SKIP = new Set(
  (process.env.MINDER_CAPTURE_SKIP || '').split(',').map((v) => v.trim()).filter(Boolean),
);
const ONLY = new Set(
  (process.env.MINDER_CAPTURE_ONLY || '').split(',').map((v) => v.trim()).filter(Boolean),
);
// Pure predicate — no logging, so go() can consult it without duplicating the
// "not selected" line that owned() prints at the shoot() call site.
function selected(name) {
  const wanted = ONLY.size === 0 || ONLY.has(name);
  return wanted && !SKIP.has(name);
}
function owned(name) {
  if (selected(name)) return false;
  console.log(`  -  ${name}.png (not selected for this run)`);
  return true;
}

mkdirSync(OUT, { recursive: true });

// Same per-shot isolation as capture-screenshots.mjs: 25 shots in a row means
// one slow route would otherwise discard every capture after it.
const failures = [];
// A failed navigation leaves the browser on the PREVIOUS route, so shooting
// afterwards writes the wrong page under the new name — worse than no shot.
let lastNavOk = true;
// Whether the last go() reached a settled (not-loading) view. Shooting a view
// that never settled is how /status shipped as four empty grey bars — the shot
// "succeeded" in every mechanical sense and published a loading state.
let lastSettled = true;
// A POSITIVE assertion about this view's data failed. Mirrors capture-screenshots.mjs:
// unlike a settle timeout this cannot be re-checked generically, because the page
// is genuinely QUIET while its data is missing — settleBeforeShot would pass and
// publish exactly the placeholder the assertion exists to catch. Hard refusal,
// reset by each successful go().
let lastAssertFailed = false;


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
  if (lastAssertFailed) {
    console.warn(`  ⚠  ${name}.png skipped — its data never arrived (positive assertion failed)`);
    failures.push(name);
    return;
  }
  if (!lastSettled) {
    // A navigation-time hint, not a verdict: a route that finished loading just
    // after the stability timeout (or during postSettle) is idle by the time the
    // shutter fires. Refusing here turned a transient delay near the boundary
    // into a failed capture and left the published image stale. Defer to
    // settleBeforeShot, which asks at the moment that matters.
    console.warn(`  ⚠  ${name}: had not settled at navigation time — re-checking at capture`);
  }
  if (!(await settleBeforeShot(page))) {
    console.warn(`  ⚠  ${name}.png skipped — still loading at capture time`);
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

// Assert the view is not loading AT SHUTTER TIME, and wait if it is.
//
// Checking during go() is not enough and was the bug that published
// memory-observatory.png with the word "Loading" in it: the settle gate ran
// before the panel had even mounted its loading indicator, found a quiet page,
// and returned — then the panel mounted, started loading, and the screenshot
// was taken. The only moment whose answer matters is the moment of capture.
async function settleBeforeShot(page, budgetMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    const busy = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return /Compiling/i.test(text)
        || /\bLoading\b/i.test(text)
        || /\bConnecting\b/i.test(text)
        || document.querySelectorAll('.animate-pulse').length > 0
        || [...document.querySelectorAll('[style*="pulse"]')]
          .some((el) => el.getBoundingClientRect().height >= 24);
      // Fail toward BUSY: an evaluation error (detached frame, navigation in
      // flight) teaches us nothing about the view, and "nothing" must not read
      // as "idle". Waiting and then refusing beats publishing a blank.
    }).catch(() => true);
    if (!busy) {
      // Hold briefly and re-confirm, so a gap between two loading phases is not
      // mistaken for the end of loading.
      await page.waitForTimeout(1500);
      const stillIdle = await page.evaluate(() => {
        const text = document.body.innerText || '';
        return !(/Compiling/i.test(text) || /\bLoading\b/i.test(text)
          || /\bConnecting\b/i.test(text)
          || document.querySelectorAll('.animate-pulse').length > 0
        || [...document.querySelectorAll('[style*="pulse"]')]
          .some((el) => el.getBoundingClientRect().height >= 24));
      }).catch(() => false);
      if (stillIdle) return true;
      continue;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

// Wait until the view has stopped loading.
//
// The app has four loading idioms (#445) and gating on `.animate-pulse` alone
// published /status as four empty grey bars. All four are covered here, matching
// capture-screenshots.mjs:
//   A  `<Skeleton>`            -> `.animate-pulse`
//   B  plain "Loading…"/"Connecting…" text (~20 components)
//   C  bespoke placeholder divs (~12) — NO class and NO text, but they carry an
//      INLINE `animation: "pulse …"` (StatusDashboard.tsx:80), so `[style*="pulse"]`
//      finds them. Match the animation NAME, not the property: DashboardGrid.tsx:454
//      renders `animation: loading ? "spin …" : "none"`, and `[style*="animation"]`
//      would match that IDLE state and never settle.
//   D  Next's "Compiling" pill
//
// Text and markers alone are still not sufficient, so this also blocks on the
// body text length holding steady. Length rather than content, so a ticking
// relative timestamp ("3m ago" -> "4m ago") does not count as churn and prevent
// the page from ever settling.
async function waitForStableUI(page, { timeout = 25000, quietMs = 6000 } = {}) {
  try {
    await page.waitForFunction(
      (quiet) => {
        const w = /** @type {any} */ (window);
        const now = Date.now();
        const text = document.body.innerText || '';
        const busy =
          /Compiling/i.test(text) ||
          /\bLoading\b/i.test(text) ||
          /\bConnecting\b/i.test(text) ||
          document.querySelectorAll('.animate-pulse').length > 0
        || [...document.querySelectorAll('[style*="pulse"]')]
          .some((el) => el.getBoundingClientRect().height >= 24);
        const growing = text.length !== w.__minderLastLen;
        w.__minderLastLen = text.length;
        if (busy || growing) {
          w.__minderQuietSince = null;
          return false;
        }
        if (!w.__minderQuietSince) {
          w.__minderQuietSince = now;
          return false;
        }
        return now - w.__minderQuietSince >= quiet;
      },
      quietMs,
      { timeout, polling: 400 },
    );
    return true;
  } catch {
    // Budget expired with the view still loading. Returning false sets
    // lastSettled, and shoot() then skips the capture and records a failure.
    return false;
  }
}

// Positive assertion that a view's DATA arrived, for shots where a quiet-window
// heuristic is provably not enough. Mirrors capture-screenshots.mjs. Used here by
// `mcp-security`: ConfigBrowser's pending catalog is six text-free, class-free,
// UNANIMATED divs (ConfigBrowser.tsx:208-220), so the body text length holds
// steady while it loads and every generic check reads that as settled.
async function waitForPattern(page, source, timeout = 60000) {
  try {
    await page.waitForFunction(
      (src) => new RegExp(src).test(document.body.innerText || ''),
      source,
      { timeout, polling: 500 },
    );
    return true;
  } catch {
    return false;
  }
}

async function go(page, route, settle = 800, { stableTimeout = 60000, postSettle = 4000, shot } = {}) {
  // A targeted run must not pay for routes it will never photograph. Navigating
  // and settling costs up to 60s per route, so without this bail MINDER_CAPTURE_ONLY
  // saves nothing — it would still walk all 21 routes to produce one image.
  // `shot` names the capture(s) this navigation exists for; when none is still
  // selected, skip the expensive part. The matching shoot() calls are separately
  // guarded by owned(), which prints the skip line.
  //
  // With no env vars set ONLY is empty, selected() is always true, and this can
  // never fire — a full capture run is byte-identical to before.
  if (shot && ![].concat(shot).some(selected)) return false;
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
    // Per-view state: a previous route's failed assertion must not refuse this one.
    lastAssertFailed = false;
  } catch (err) {
    lastNavOk = false;
    console.warn(`  ⚠  navigation to ${route} failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    return false;
  }
  await page.waitForTimeout(settle);
  lastSettled = await waitForStableUI(page, { timeout: stableTimeout });
  if (!lastSettled) {
    console.warn(`  ⚠  ${route} never stopped loading within ${Math.round(stableTimeout / 1000)}s`);
  }
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
  // Only the two session shots need this, and the request is expensive (a cold
  // parse of a ~6,000-session index). A targeted run for an unrelated image
  // should not pay for it, so skip the lookup when neither shot is selected.
  const needsSession = ['session-replay-scrubber', 'session-diagnosis'].some(selected);
  let firstSessionId = null;
  if (needsSession) {
    console.log('Fetching first session ID for session-detail captures...');
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
  }

  console.log('\nCapturing 25 new screenshots...\n');

  // ── Memory Observatory ────────────────────────────────────
  console.log('Memory Observatory:');
  await go(page, '/memory', 1200, { shot: 'memory-observatory' });
  if (!owned('memory-observatory')) await shoot(page, 'memory-observatory');

  await go(page, '/memory/seed', 1000, { shot: 'memory-seed' });
  if (!owned('memory-seed')) await shoot(page, 'memory-seed');

  await go(page, '/memory/triage', 1000, { shot: 'memory-triage' });
  if (!owned('memory-triage')) await shoot(page, 'memory-triage');

  // ── Multi-Agent Coordination ──────────────────────────────
  console.log('\nMulti-Agent:');
  await go(page, '/agent-view', 1200, { shot: 'agent-view' });
  if (!owned('agent-view')) await shoot(page, 'agent-view');

  await go(page, '/kanban', 1200, { shot: 'kanban' });
  // Kanban defaults to the "Board" source, which is empty unless BOARD.md has
  // open issues — so the default view published as four "Nothing here" columns.
  // The prose describes this page as unifying *sessions with dispatcher tasks*,
  // which is the "All" source. Switch to it so the shot shows what it claims.
  if (selected('kanban')) {
    await clickButton(page, 'All');
    await page.waitForTimeout(1500);
  }
  if (!owned('kanban')) await shoot(page, 'kanban');

  await go(page, '/tasks', 1000, { shot: 'tasks' });
  if (!owned('tasks')) await shoot(page, 'tasks');

  await go(page, '/swarms', 1000, { shot: 'swarms' });
  if (!owned('swarms')) await shoot(page, 'swarms');

  // ── Templates & Library ───────────────────────────────────
  console.log('\nTemplates & Library:');
  await go(page, '/templates', 1000, { shot: 'templates' });
  if (!owned('templates')) await shoot(page, 'templates');

  await go(page, '/library', 1200, { shot: 'library' });
  if (!owned('library')) await shoot(page, 'library');

  await go(page, '/new-project', 1000, { shot: 'new-project-wizard' });
  if (!owned('new-project-wizard')) await shoot(page, 'new-project-wizard');

  // ── Config Linting & Security ─────────────────────────────
  console.log('\nConfig Lint & Security:');
  // ConfigLintPanel lives on project detail under ?tab=config-lint
  await go(page, `/project/${PROJECT}?tab=config-lint`, 1200, { shot: 'config-linter' });
  if (!owned('config-linter')) await shoot(page, 'config-linter');

  // MCP tab on global Config browser, with security findings.
  //
  // Needs a positive assertion, because this route defeats every generic check:
  // ConfigBrowser renders its pending catalog as six placeholder divs carrying
  // NO text, NO class and NO animation — just height/background/opacity
  // (ConfigBrowser.tsx:208-220). Body text length therefore holds perfectly
  // steady while it loads, which the quiet window reads as "settled".
  //
  // So assert on the fetch that fills the catalog, as /config does in
  // capture-screenshots.mjs. Armed BEFORE navigating: the response lands inside
  // go()'s settle window, and a waiter created after would miss it.
  if (selected('mcp-security')) {
    // TWO readiness paths, because the two render modes are mutually exclusive:
    //
    //  rscHydration ON (the default) — the catalog is prefetched on the server
    //    and streamed into the query cache, so the browser deliberately makes
    //    NO /api/claude-config request and the page paints with data already
    //    present. Waiting on the response alone would time out on every default
    //    run and fail the whole capture.
    //  rscHydration OFF — the client fetches on mount, and until it resolves
    //    ConfigBrowser shows the text-free placeholders described above.
    //
    // So: accept a populated tab count (covers the hydrated path, where the
    // data is already painted) OR an observed fetch (covers the client path,
    // where counts may legitimately be 0). Same residual as /config: hydrated
    // AND every catalog genuinely empty warns and refuses rather than
    // publishing placeholders.
    const mcpFetched = page
      .waitForResponse(
        (r) => r.url().includes('/api/claude-config') && r.status() === 200,
        { timeout: 60000 },
      )
      .then(() => true)
      .catch(() => false);
    await go(page, '/config?type=mcp', 1200, { shot: 'mcp-security' });
    // MCP-SPECIFIC signals only. `?type=mcp` returns a type-scoped payload, so
    // every OTHER tab count stays at 0 even when the page is fully loaded — a
    // general "any count is non-zero" test can never pass here.
    //
    // Accept a populated MCP count, or the valid empty state that the hydrated
    // path renders for a legitimately empty catalog (ConfigBrowser.tsx:688).
    // Unlike the "No hooks configured." mistake on /config, this text IS on the
    // active tab: ?type=mcp opens the MCP tab, which is what renders it.
    const MCP_READY = 'MCP\\s+[1-9]|No MCP servers configured';
    if (!(await waitForPattern(page, MCP_READY, 10000)) && !(await mcpFetched)) {
      console.warn('  ⚠  mcp-security: MCP catalog neither populated nor empty-stated, and no fetch seen');
      lastAssertFailed = true;
    }
  }
  if (!owned('mcp-security')) await shoot(page, 'mcp-security');

  // Config history tab on project detail
  await go(page, `/project/${PROJECT}?tab=config-history`, 1000, { shot: 'config-history' });
  if (!owned('config-history')) await shoot(page, 'config-history');

  // ── Session Quality & Diagnosis ───────────────────────────
  console.log('\nSession Quality:');
  if (firstSessionId) {
    // Timeline with replay scrubber + retry-cycle highlights (default tab)
    await go(page, `/sessions/${firstSessionId}`, 2500, {
      shot: ['session-replay-scrubber', 'session-diagnosis'],
    });
    if (!owned('session-replay-scrubber')) await shoot(page, 'session-replay-scrubber');

    // Diagnosis tab — use locator with :has-text() for direct text match
    // (getByRole + regex was returning empty even with TabBar rendered).
    // Gated like the /settings tab clicks: a run that only wants
    // session-replay-scrubber should not pay for this click, nor risk its
    // flakiness. It also leaves the scrubber's own view undisturbed.
    if (selected('session-diagnosis')) {
      try {
        await page.locator('button:has-text("Diagnosis")').first().click({ timeout: 5000 });
        await page.waitForTimeout(600);
      } catch {
        console.warn('  ⚠  could not click Diagnosis tab — capturing current view');
      }
    }
    if (!owned('session-diagnosis')) await shoot(page, 'session-diagnosis');
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
  await go(page, '/settings', 2000, {
    shot: ['notifications', 'settings-cost-cap', 'settings-adapters'],
  });
  // Each tab click is guarded by its own shot: when go() above has bailed, the
  // browser is still on the previous route and these would click into it. The
  // tabs are independent, so skipping one does not strand the next.
  if (selected('notifications')) await clickButton(page, 'Notifications');
  if (!owned('notifications')) await shoot(page, 'notifications');

  if (selected('settings-cost-cap')) await clickButton(page, 'Cost');
  if (!owned('settings-cost-cap')) await shoot(page, 'settings-cost-cap');

  if (selected('settings-adapters')) await clickButton(page, 'Adapters');
  if (!owned('settings-adapters')) await shoot(page, 'settings-adapters');

  // ── Power-User Tools ──────────────────────────────────────
  console.log('\nPower Tools:');
  await go(page, '/commands', 1200, { shot: 'commands' });
  if (!owned('commands')) await shoot(page, 'commands');

  await go(page, '/sql', 1000, { shot: 'sql' });
  if (!owned('sql')) await shoot(page, 'sql');

  await go(page, '/plans', 1000, { shot: 'plans' });
  if (!owned('plans')) await shoot(page, 'plans');

  await go(page, '/schedule', 1000, { shot: 'schedule' });
  if (!owned('schedule')) await shoot(page, 'schedule');

  await go(page, '/health', 1000, { shot: 'health' });
  if (!owned('health')) await shoot(page, 'health');

  await go(page, '/insights-report', 1500, { shot: 'insights-report' });
  if (!owned('insights-report')) await shoot(page, 'insights-report');

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
