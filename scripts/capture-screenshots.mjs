import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Default targets the dev server (port 4100). The prod-capture orchestrator
// (scripts/capture-screenshots-prod.mjs) sets MINDER_CAPTURE_BASE to point at
// a prod-built `next start` on a different port — avoids dev-mode "Compiling…"
// pills and skeleton placeholders.
const BASE = process.env.MINDER_CAPTURE_BASE || 'http://localhost:4100';
// MINDER_CAPTURE_OUT lets a second pass write somewhere other than the live
// screenshot directory — the hybrid orchestrator captures a demo-mode pass into
// a temp dir and then promotes only the shots demo fixtures actually improve.
const OUT  = process.env.MINDER_CAPTURE_OUT || join(__dirname, '..', 'site', 'screenshots');
// The project whose detail page the per-project shots use. Demo mode has no
// `project-minder` — that route renders "Project not found" — so the demo pass
// points these at a fixture project instead.
const PROJECT = process.env.MINDER_CAPTURE_PROJECT || 'project-minder';
// Capture at 2x device pixel ratio. The landing page displays these at up to
// ~1130 CSS px and the lightbox shows them at full size, so a 1x capture was
// being upscaled in the lightbox and resampled on every HiDPI screen. 2x costs
// ~4x the bytes and is the whole fix for "screenshots are low-resolution".
const DPR = Number(process.env.MINDER_CAPTURE_DPR || 2);
// Nav timeout. 90s was too tight against a real index: /usage aggregates
// thousands of sessions server-side and blew that budget. The deck script
// already runs at 180s for the same reason.
const NAV_TIMEOUT = Number(process.env.MINDER_CAPTURE_NAV_TIMEOUT || 180000);


mkdirSync(OUT, { recursive: true });

// Shots another pass owns (the hybrid orchestrator hands its demo-pass list to
// the real pass). Skipping the NAVIGATION matters as much as skipping the file:
// /usage and /stats run heavy synchronous SQLite aggregations that monopolise
// the server's event loop, leaving it unresponsive for every shot AFTER them —
// so visiting a route whose output we intend to throw away is not merely
// wasteful, it breaks the rest of the run.
const SKIP = new Set(
  (process.env.MINDER_CAPTURE_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean),
);
function owned(name) {
  if (!SKIP.has(name)) return false;
  console.log(`  –  ${name}.png (owned by another pass)`);
  return true;
}

// One slow route must not abandon the rest of the run. This script used to die
// on the first timeout — losing every shot after it — which turned a full
// refresh into a whack-a-mole of one-fix-per-20-minute-run. Failures are
// collected and reported at the end, and a missing published shot exits
// non-zero so a partial run can't read as success.
const failures = [];

// Whether the most recent go() actually landed. A failed navigation leaves the
// browser on the PREVIOUS route, so shooting afterwards would write the wrong
// page under the new shot's name — a silently incorrect screenshot, which is
// worse than a missing one.
let lastNavOk = true;
// Whether the last go() reached a settled (not-loading) view. Shooting a view
// that never settled is how /status shipped as four empty grey bars — the shot
// "succeeded" in every mechanical sense and published a loading state.
let lastSettled = true;

// Chromium renders its OWN error page ("This page couldn't load", "Aw, Snap!")
// as a perfectly successful navigation, so checking that go() resolved does not
// catch a crashed renderer or a dead server. On 2026-08-12 that shipped a
// screenshot of the browser error page into usage-dashboard.png, which passed
// every other guard: nav ok, screenshot taken, file written, 2x dimensions.
// The only tell was the file size.
async function pageIsHealthy(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body.innerText || '';
      if (/This page couldn.t load|site can.t be reached|Aw, Snap|ERR_[A-Z_]{3,}/i.test(text)) {
        return false;
      }
      // The app shell always paints its sidebar; a bare error page has no links.
      return document.querySelectorAll('a').length > 0;
    });
  } catch {
    return false;
  }
}

// `optional: true` marks a shot site/index.html does not reference (worktrees),
// where skipping is a normal outcome rather than a failure.
async function shoot(page, name, { selector, optional = false } = {}) {
  if (!lastNavOk) {
    console.warn(`  ⚠  ${name}.png skipped — its page failed to load (previous shot's page still displayed)`);
    if (!optional) failures.push(name);
    return;
  }
  if (!lastSettled) {
    console.warn(`  ⚠  ${name}.png skipped — the view never finished loading`);
    if (!optional) failures.push(name);
    return;
  }
  if (!(await settleBeforeShot(page))) {
    console.warn(`  ⚠  ${name}.png skipped — still loading at capture time`);
    if (!optional) failures.push(name);
    return;
  }
  if (!(await pageIsHealthy(page))) {
    console.warn(`  ⚠  ${name}.png skipped — the browser is showing an error page, not the app`);
    if (!optional) failures.push(name);
    return;
  }
  const dest = join(OUT, `${name}.png`);
  // Playwright's default screenshot timeout is 30s, which this script was
  // relying on implicitly — and at deviceScaleFactor 2 the raster is 4x the
  // pixels, so it started blowing that budget on heavier routes. `animations:
  // disabled` matters just as much: Playwright waits for animations to settle,
  // and this app polls and re-renders continuously, so a live panel can hold a
  // screenshot open indefinitely. Disabling finishes them at their end state.
  const opts = { path: dest, timeout: 120000, animations: 'disabled', caret: 'hide' };
  try {
    if (selector) {
      const el = await page.waitForSelector(selector);
      await el.screenshot(opts);
    } else {
      await page.screenshot({ ...opts, fullPage: false });
    }
    console.log(`  ✓  ${name}.png`);
  } catch (err) {
    console.warn(`  ⚠  ${name}.png failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    if (!optional) failures.push(name);
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
        || document.querySelectorAll('.animate-pulse, [style*="pulse"]').length > 0;
    }).catch(() => false);
    if (!busy) {
      // Hold briefly and re-confirm, so a gap between two loading phases is not
      // mistaken for the end of loading.
      await page.waitForTimeout(1500);
      const stillIdle = await page.evaluate(() => {
        const text = document.body.innerText || '';
        return !(/Compiling/i.test(text) || /\bLoading\b/i.test(text)
          || /\bConnecting\b/i.test(text)
          || document.querySelectorAll('.animate-pulse, [style*="pulse"]').length > 0);
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
// published /status as four empty grey bars and /config with every tab count
// reading 0. All four are covered here:
//   A  `<Skeleton>`            -> `.animate-pulse`
//   B  plain "Loading…"/"Connecting…" text (~20 components)
//   C  bespoke placeholder divs (~12) — NO class and NO text, so they look
//      identical to a settled page. They are still detectable: they carry an
//      INLINE `animation: "pulse 1.5s ease-in-out infinite"`
//      (StatusDashboard.tsx:80, DiagnosisPanel.tsx:159), hence `[style*="pulse"]`.
//   D  Next's "Compiling" pill
//
// Match the animation NAME, not the `animation` property: DashboardGrid.tsx:454
// renders `animation: loading ? "spin …" : "none"`, so a `[style*="animation"]`
// selector would match the IDLE state too and the gate would never settle.
//
// Text alone is still not sufficient, so this also blocks on the body text
// length holding steady. Length rather than content, so a ticking relative
// timestamp ("3m ago" -> "4m ago") does not count as churn and prevent the page
// from ever settling.
//
// Until the app grows a single marker, approximate one from the outside: a view
// that is still loading has text that is still CHANGING. So block on the two
// detectable idioms AND on the body text length holding steady. Length rather
// than content, so a ticking relative timestamp ("3m ago" -> "4m ago") does not
// count as churn and prevent the page from ever settling.
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
          document.querySelectorAll('.animate-pulse, [style*="pulse"]').length > 0;
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
    // lastSettled, and shoot() then skips the capture — recording a failure
    // unless the shot is marked optional.
    return false;
  }
}

// waitForStableUI only recognises .animate-pulse skeletons. Panels that print a
// plain "loading…" string instead sail straight past it, and the 4s postSettle
// is not always enough — the Home overview shipped a hero image reading
// "CONFIG HEALTH — loading…" and "0 projects · 0 active sessions" because its
// stat cards had not resolved when the shutter fired.
async function waitForTextGone(page, text, timeout = 45000) {
  try {
    await page.waitForFunction(
      (t) => !(document.body.innerText || '').toLowerCase().includes(t),
      text.toLowerCase(),
      { timeout, polling: 500 },
    );
    return true;
  } catch {
    return false;
  }
}

// Positive assertion that a view's DATA arrived, for shots where a quiet-window
// heuristic is provably not enough. /config is the worked example: its tab
// counts stay at 0 while the page text is otherwise stable, then a SECOND data
// wave lands at ~20s and fills them in (measured). Any settle heuristic short of
// that publishes "Settings 0 Hooks 0 Plugins 0 MCP 0" — which is what shipped.
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
  lastSettled = await waitForStableUI(page, { timeout: stableTimeout });
  if (!lastSettled) {
    console.warn(`  ⚠  ${route} never stopped loading within ${Math.round(stableTimeout / 1000)}s`);
  }
  await page.waitForTimeout(postSettle);
  return true;
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx     = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR });
  const page    = await ctx.newPage();

  // /api/sessions is one of the heavy endpoints, so don't pay for it when the
  // only shot that needs it belongs to another pass.
  let firstSessionId = null;
  if (SKIP.has('session-detail')) {
    console.log('Skipping session lookup — session-detail is owned by another pass.');
  } else try {
    console.log('Fetching first session ID...');
    // Needs an explicit timeout: Playwright's default is 30s and /api/sessions
    // takes longer than that against a large index, which threw an UNCAUGHT
    // rejection here and killed the whole run before a single shot was taken.
    // Every other failure mode in this block is already a warn-and-continue, so
    // a slow endpoint should be too.
    // page.request.get, NOT page.goto + response.json(): a navigation response
    // body is read back over the DevTools protocol and this payload is large
    // enough to be evicted from that buffer first ("Request content was evicted
    // from inspector cache").
    const resp = await page.request.get(`${BASE}/api/sessions`, { timeout: 180000 });
    if (!resp) {
      console.warn('  ⚠  Sessions endpoint did not respond — session-detail screenshot will be skipped');
    } else if (!resp.ok()) {
      console.warn(`  ⚠  Sessions endpoint returned ${resp.status()} — session-detail screenshot will be skipped`);
    } else {
      const sessions = await resp.json();
      firstSessionId = sessions[0]?.sessionId ?? null;
      if (!firstSessionId) {
        console.warn('  ⚠  No sessions found — session-detail screenshot will be skipped');
      }
    }
  } catch (err) {
    console.warn(
      `  ⚠  Sessions endpoint failed (${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — ` +
      'session-detail screenshot will be skipped',
    );
  }

  console.log('\nCapturing screenshots...');

  // 1. Dashboard — full viewport
  if (!owned('dashboard')) {
    // This is the hero image, and the Home overview's stat cards resolve after
    // the generic stability gate has already given up (they render "loading…"
    // text, not a skeleton). Wait for that to clear before shooting.
    await go(page, '/', 2000, { postSettle: 6000 });
    if (await waitForTextGone(page, 'loading…')) {
      await page.waitForTimeout(2500);
      await shoot(page, 'dashboard');
    } else {
      // Do NOT shoot. This shot exists because a loading-state hero shipped
      // once already; warning and overwriting anyway would reproduce exactly
      // that, and count it as a success.
      console.warn('  ⚠  dashboard.png skipped — stat cards still showing "loading…" after 45s');
      failures.push('dashboard');
    }
  }

  // 2. Project detail — Overview tab
  if (!owned('project-detail')) {
    await go(page, `/project/${PROJECT}`, 900);
    await shoot(page, 'project-detail');
  }

  // 3. Sessions browser
  if (!owned('sessions-browser')) {
    await go(page, '/sessions');
    await shoot(page, 'sessions-browser');
  }

  // 4. Session detail.
  //
  // A missing session id is a FAILURE, not a quiet skip: session-detail.png is
  // published by site/index.html, so exiting 0 here would let the orchestrator
  // report a successful refresh while the site keeps the previous image. The
  // lookup above is best-effort precisely so one slow endpoint cannot kill the
  // run — but "we could not get the data" still has to be recorded.
  if (!owned('session-detail')) {
    if (firstSessionId) {
      await go(page, `/sessions/${firstSessionId}`, 900);
      await shoot(page, 'session-detail');
    } else {
      console.warn('  ⚠  session-detail.png skipped — no session id could be fetched');
      failures.push('session-detail');
    }
  }

  // 5. Insights browser
  if (!owned('insights-browser')) {
    await go(page, '/insights');
    await shoot(page, 'insights-browser');
  }

  // 6. Usage dashboard
  if (!owned('usage-dashboard')) {
    await go(page, '/usage', 900);
    await shoot(page, 'usage-dashboard');
  }

  // 7. Stats dashboard
  if (!owned('stats-dashboard')) {
    await go(page, '/stats', 900);
    await shoot(page, 'stats-dashboard');
  }

  // 8. Manual steps
  if (!owned('manual-steps')) {
    await go(page, '/manual-steps');
    await shoot(page, 'manual-steps');
  }

  // 9. TODOs tab — project detail, TODOs tab. (Previously misnamed "worktrees";
  // the real worktree-overlay shot is step 15 below, captured only when an
  // active worktree exists.)
  if (!owned('todos-tab')) {
    await go(page, `/project/${PROJECT}`, 900);
    try {
      await page.getByRole('tab', { name: 'TODOs' }).click();
      await page.waitForTimeout(400);
    } catch { /* tab absent or already active — screenshot whatever is visible */ }
    await shoot(page, 'todos-tab');
  }

  // 10. Setup page
  if (!owned('setup')) {
    await go(page, '/setup');
    await shoot(page, 'setup');
  }

  // 11. Config page
  if (!owned('config')) {
    await go(page, '/config', 1200, { postSettle: 6000 });
    // The tab counts are the only reliable "data arrived" signal here: they sit
    // at 0 while the rest of the page is already stable, and fill in on a second
    // wave ~20s after navigation.
    //
    // Accept ANY catalog tab becoming non-zero, or the explicit empty state.
    // Requiring `Hooks >= 1` alone bakes in this machine's install: on a clean
    // checkout with no hooks configured, "Hooks 0" plus "No hooks configured."
    // (ConfigBrowser.tsx) is the correct FINAL state, and the assertion would
    // burn its full 60s budget and then refuse a perfectly good capture.
    const CONFIG_READY = 'Hooks\\s+[1-9]|Plugins\\s+[1-9]|MCP\\s+[1-9]|No hooks configured';
    if (!(await waitForPattern(page, CONFIG_READY))) {
      console.warn('  ⚠  config: no catalog count filled in and no empty state shown');
      lastSettled = false;
    }
    await shoot(page, 'config');
  }

  // 12. System Status page — live cross-project session bucket view
  if (!owned('status')) {
    await go(page, '/status', 1200);
    await shoot(page, 'status');
  }

  // 13. Memory tab on project detail — MEMORY.md overview
  if (!owned('memory')) {
    // The Memory tab fetches its file list after mount and renders an empty
    // panel until it arrives — no skeleton, so the stability gate returns
    // immediately and a short settle captures a blank box.
    await go(page, `/project/${PROJECT}?tab=memory`, 1500, { postSettle: 10000 });
    await shoot(page, 'memory');
  }

  // 14. The project card grid, plus an element crop of one card.
  //
  // Both read from `/projects`, not `/`: the Claudoscope redesign moved the
  // card grid off `/` and put the Home overview there, so `/` no longer
  // contains a single `a[href="/project/..."]`. The old selector silently
  // pointed at a page with no cards on it.
  //
  // If the anchor never appears, shoot() records the failure and leaves the
  // previous card-detail.png in place rather than throwing.
  if (!owned('projects-grid')) {
    await go(page, '/projects', 1200);
    await shoot(page, 'projects-grid');
    await shoot(page, 'card-detail', { selector: `a[href="/project/${PROJECT}"]` });
  }

  // 15. Worktree overlay — the dedicated "Worktrees" panel on a project that has
  // an active Claude Code worktree (the `*--claude-worktrees-*` convention).
  // Self-discovers the first project with a worktree overlay via /api/projects
  // (reusing Minder's own detection), so it captures the feature "in the wild."
  // When no worktree is active it SKIPS without writing a file, leaving any
  // prior worktrees.png untouched — the site never references a missing/stale
  // shot. See TODO.md "Capture a real worktree-overlay shot".
  let worktreeProjectSlug = null;
  try {
    const presp = await page.goto(`${BASE}/api/projects`);
    if (presp && presp.ok()) {
      const data = await presp.json();
      const projects = Array.isArray(data) ? data : (data.projects ?? []);
      const withWorktree = projects.find(
        (p) => Array.isArray(p.worktrees) && p.worktrees.length > 0,
      );
      worktreeProjectSlug = withWorktree?.slug ?? null;
    }
  } catch {
    /* projects endpoint unavailable — handled by the skip below */
  }

  if (worktreeProjectSlug) {
    await go(page, `/project/${worktreeProjectSlug}`, 900);
    try {
      // Expand the "Worktrees (N)" panel on the Overview tab, then let its
      // per-worktree status rows (/api/worktrees) settle before shooting.
      await page.getByRole('button', { name: /Worktrees \(\d+\)/ }).click();
      await page.waitForTimeout(800);
      await waitForStableUI(page, { timeout: 15000 });
    } catch {
      /* panel markup changed — capture whatever's on screen */
    }
    await shoot(page, 'worktrees', { optional: true });
  } else {
    console.warn(
      '  ⚠  No active worktree overlay found in any project — worktrees.png not regenerated (see TODO.md).',
    );
  }

  await browser.close();
  console.log(`\nAll screenshots saved to:\n  ${OUT}\n`);

  if (failures.length) {
    console.error(
      `✗ ${failures.length} published shot(s) failed: ${failures.join(', ')}\n` +
      '  site/index.html references these, so the page still shows their previous version.',
    );
    process.exitCode = 1;
  }
})().catch((err) => {
  // Anything escaping the per-shot guards is a real bug — surface it as a
  // non-zero exit rather than an unhandled rejection warning.
  console.error('\n✗ capture-screenshots failed:', err);
  process.exit(1);
});
