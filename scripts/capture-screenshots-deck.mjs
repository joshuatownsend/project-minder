// Captures the Command Deck / cost-accounting / power-tool screenshots added
// after the v1.10 line. Pairs with capture-screenshots.mjs (original landing
// set), capture-agents-skills.mjs (agents/skills/provenance) and
// capture-screenshots-extended.mjs (the memory/multi-agent/config-lint set).
//
// Run with the dev server already running on http://localhost:4100 — or set
// MINDER_CAPTURE_BASE to point at a server on a different port.
//
// Two shots need a *specific* host project rather than project-minder itself:
//   - ops-panel     → a project with detectable ops surface (services/DB/hosting).
//                     project-minder has no OPERATIONS.md and no external
//                     services, so its Ops tab does not render at all.
//   - board         → the Board is empty across a fresh portfolio, so this one
//                     is captured against a MINDER_DEMO=1 server whose fixtures
//                     are deterministic. See MINDER_CAPTURE_DEMO_BASE below;
//                     the shot is skipped (loudly) when that is unset.
// Override the ops host with MINDER_CAPTURE_OPS_PROJECT=<slug>.
//
// All output lands in site/screenshots/.

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.MINDER_CAPTURE_BASE || 'http://localhost:4100';
const DEMO_BASE = process.env.MINDER_CAPTURE_DEMO_BASE || '';
const OPS_PROJECT = process.env.MINDER_CAPTURE_OPS_PROJECT || 'perfect-palette';
// MINDER_CAPTURE_OUT lets the demo pass write to a temp dir instead of the live
// screenshot directory; MINDER_CAPTURE_DPR=2 is the resolution fix (see
// capture-screenshots.mjs for the rationale).
const OUT = process.env.MINDER_CAPTURE_OUT || join(__dirname, '..', 'site', 'screenshots');
const DPR = Number(process.env.MINDER_CAPTURE_DPR || 2);
// Demo mode has no `project-minder` (that route renders "Project not found"),
// so the demo pass points the per-project shots at a fixture project instead.
const PROJECT = process.env.MINDER_CAPTURE_PROJECT || 'project-minder';
// Shots another pass owns (see capture-screenshots.mjs for why skipping the
// navigation matters, not just the file write).
const SKIP = new Set(
  (process.env.MINDER_CAPTURE_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean),
);

mkdirSync(OUT, { recursive: true });


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

async function shoot(page, name) {
  if (!(await pageIsHealthy(page))) {
    throw new Error('browser is showing an error page, not the app');
  }
  const dest = join(OUT, `${name}.png`);
  // `animations: disabled` stops a continuously-polling panel from holding the
  // screenshot open while Playwright waits for animations to settle.
  await page.screenshot({ path: dest, fullPage: false, timeout: 120000, animations: 'disabled', caret: 'hide' });
  console.log(`  ✓  ${name}.png`);
}

// Same stability gate as capture-screenshots-extended.mjs: wait until the
// Next dev "Compiling…" pill and every .animate-pulse skeleton have been gone
// for ~1.5s sustained, via page-context JS so the wait stays bounded.
// Returns false when the budget expired with the page still loading. The
// caller must not swallow that: shoot() would happily overwrite a published
// PNG with a skeleton, leaving `skipped` empty and the run green — a stale
// image published under a passing gate.
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
    return true;
  } catch {
    return false;
  }
}

// NAV_TIMEOUT defaults to 180s, double the extended script's 90s: /costs
// aggregates every project's usage and takes ~60s to compile-and-render cold
// on a large history, which overran the shorter budget twice.
const NAV_TIMEOUT = Number(process.env.MINDER_CAPTURE_NAV_TIMEOUT || 180000);

// The Claude-status banner reports whatever Anthropic's status page says at
// capture time, so a shot taken during an incident ships "Degraded performance"
// across the top of a landing-page screenshot. Hide it rather than re-shooting
// until the weather is nice: it is a live-data strip, not part of the feature
// being illustrated. Must be re-applied after every navigation.
//
// Two surfaces, not one. ClaudeStatusBanner renders the strip, but
// ClaudeStatusProvider *also* pushes incident transitions through the generic
// toast container once its status fetch resolves — which lands after the
// banner is already hidden, so hiding the banner alone is not enough. A
// "Claude incident resolved" toast reached a committed screenshot this way.
// The toast container has no stable hook, so this is coupled to the utility
// classes on the wrapper div in src/components/ui/toast.tsx; if a toast ever
// reappears in a capture, that coupling is where to look.
const TRANSIENT_SELECTORS = [
  '[data-claude-status]',
  '.fixed.bottom-4.right-4.z-50',
];

async function hideTransientBanners(page) {
  try {
    await page.addStyleTag({
      content: `${TRANSIENT_SELECTORS.join(',')}{display:none !important}`,
    });
  } catch {
    // Page navigated out from under us — the next go() will re-apply it.
  }
}

// stableTimeout defaults to the same budget as navigation. It used to be a
// fixed 60s, which was harmless while a stability timeout was swallowed — but
// now that it *fails* the run, 60s is a hair-trigger on precisely the slowest
// route: /costs is measured at ~60s cold. The wait short-circuits as soon as
// the page is quiet for 1.5s, so a higher ceiling costs nothing on a page that
// loads promptly; it only buys patience for one that does not.
async function go(page, route, settle = 1000, { base = BASE, stableTimeout = NAV_TIMEOUT, postSettle = 4000 } = {}) {
  await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await hideTransientBanners(page);
  await page.waitForTimeout(settle);
  const stable = await waitForStableUI(page, { timeout: stableTimeout });
  await page.waitForTimeout(postSettle);
  // The banner mounts after a delay (it waits on its own fetch), so re-apply
  // once the page has settled or it reappears between the two waits.
  await hideTransientBanners(page);
  return stable;
}

// waitForStableUI only knows about .animate-pulse skeletons. Panels that print
// their own loading sentence instead ("Analyzing file activity…") sail straight
// through it, and the shot catches the spinner rather than the feature. Give
// those a literal string to wait out.
const DEFAULT_TEXT_WAIT_MS = 60000;

async function waitForTextGone(page, text, timeout = DEFAULT_TEXT_WAIT_MS) {
  try {
    await page.waitForFunction(
      (t) => !(document.body.innerText || '').includes(t),
      text,
      { timeout, polling: 500 },
    );
    return true;
  } catch {
    return false;
  }
}

// The mirror of waitForTextGone, for shots whose subject can legitimately
// render as nothing. A panel that is empty because its data never arrived
// looks identical to one that finished, so those shots need positive evidence
// that the feature is actually on screen before the PNG is overwritten.
// Case-insensitive on purpose. `innerText` returns *rendered* text, so a label
// written as "Thresholds" in the source arrives as "THRESHOLDS" when CSS
// uppercases it — a case-sensitive check failed exactly that way here, which
// would have failed the capture on a perfectly healthy page.
async function waitForTextPresent(page, text, timeout = DEFAULT_TEXT_WAIT_MS) {
  try {
    await page.waitForFunction(
      (t) => (document.body.innerText || '').toLowerCase().includes(t),
      text.toLowerCase(),
      { timeout, polling: 500 },
    );
    return true;
  } catch {
    return false;
  }
}

// Assert the requested tab is actually *selected* before shooting it.
// ProjectDetail silently falls back to Overview for a `?tab=` it does not
// offer, so without this check a rejected `?tab=ops` would ship an Overview
// screenshot captioned as the ops runbook.
//
// Presence of the button is not enough: the tab strip can list a tab that is
// not the active one. ProjectDetail marks selection with inline styles only —
// no `aria-selected`, no data attribute (see the tabs.map in
// src/components/ProjectDetail.tsx) — so selection has to be read back off the
// computed style. The active tab is the only one with a non-transparent bottom
// border.
async function tabIsActive(page, label) {
  try {
    await page.waitForSelector(`button:has-text("${label}")`, { timeout: 4000 });
  } catch {
    return false;
  }
  return page.evaluate((text) => {
    const isTransparent = (c) => !c || c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
    return [...document.querySelectorAll('button')]
      .filter((b) => (b.textContent || '').trim().startsWith(text))
      .some((b) => !isTransparent(getComputedStyle(b).borderBottomColor));
  }, label);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR });
  const page = await ctx.newPage();
  const skipped = [];

  console.log('\nCapturing Command Deck screenshots...\n');

  // Each shot is independent: one slow or missing route must not abandon the
  // rest of the run (the first attempt lost five good captures to a single
  // /costs timeout). Failures are collected and reported at the end so a
  // partial run is obvious rather than silently short.
  //
  // `requireTab` guards the ProjectDetail captures: that component silently
  // falls back to Overview for a `?tab=` it does not offer, so without the
  // check a missing Ops tab would ship an Overview screenshot captioned as
  // the ops runbook.
  const SHOTS = [
    { group: 'Command Deck', name: 'ops-panel', route: `/project/${OPS_PROJECT}?tab=ops`, settle: 1500,
      requireTab: 'Ops', why: `project "${OPS_PROJECT}" has no Ops tab — set MINDER_CAPTURE_OPS_PROJECT` },
    // GithubActivityStrip is "quiet by design": it renders nothing at all when
    // `gh` is missing, unauthenticated, or simply slower than the settle window
    // (the cache can spend three sequential 8s `gh` calls). An empty strip is
    // indistinguishable from a finished one, so this shot demands positive
    // evidence rather than trusting the generic stability check.
    { group: 'Command Deck', name: 'github-activity', route: `/project/${PROJECT}`, settle: 2000,
      requireText: 'GITHUB' },
    // `optional` marks a shot site/index.html does not reference, so skipping
    // it is a normal outcome rather than a failure. Everything else is
    // published, and failing to regenerate a published shot must not exit 0 —
    // see the exit handling at the end of this file.
    { group: 'Command Deck', name: 'board', route: '/board', settle: 1500, base: DEMO_BASE, optional: true,
      why: 'set MINDER_CAPTURE_DEMO_BASE to a MINDER_DEMO=1 server (a real board is empty until you write BOARD.md)' },
    // WorkflowsBrowser prints a plain "Loading…" paragraph rather than a
    // skeleton (src/components/WorkflowsBrowser.tsx:113), so waitForStableUI
    // sails straight past it on a large workflow history.
    { group: 'Power tools', name: 'workflows', route: '/workflows', settle: 1200,
      waitTextGone: 'Loading…' },
    // No /instructions shot on purpose. That catalog is opt-in per harness and
    // renders an empty state until a Codex or Gemini adapter is enabled, so
    // capturing it costs time and leaves an orphan PNG that site/index.html
    // does not reference. Add it back only alongside prose that uses it.
    { group: 'Power tools', name: 'code-intel', route: `/project/${PROJECT}?tab=hot-files`, settle: 1500,
      requireTab: 'Hot Files', why: 'no Hot Files tab on project-minder',
      // The panel's own endpoints are slow on a large session index
      // (hot-files ~30s, file-coupling ~100s measured), so this wait needs a
      // budget well past the 60s default or the shot lands on the spinner.
      waitTextGone: 'Analyzing file activity', waitTextTimeout: 180000 },
    // /costs runs last: it is by far the slowest route, so a timeout here
    // costs nothing that has not already been captured.
    // Both cost routes navigate fine and then render an *empty* report when
    // their child API fails: EngagementDashboard.tsx:97 prints "Engagement
    // report unavailable." on a 503, and CostReportDashboard prints "No cost
    // data for this period" with no rows. Neither is a skeleton, so only a
    // positive assertion keeps a published PNG from being replaced by one.
    { group: 'Cost & time', name: 'timecard', route: '/timecard', settle: 1500,
      requireText: 'Thresholds' },
    { group: 'Cost & time', name: 'costs', route: '/costs', settle: 1200,
      requireText: 'SHARE' },
  ];

  // MINDER_CAPTURE_ONLY=costs,timecard re-shoots a subset. /costs is slow
  // enough to time out intermittently, and re-running all seven shots to
  // recover one of them wastes several minutes of dev-server compile.
  const only = (process.env.MINDER_CAPTURE_ONLY || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  let group = null;
  // Drop shots another pass owns before doing any work for them — including the
  // navigation, which is the expensive part on the heavy analytics routes.
  const plan = SHOTS.filter((s) => {
    if (!SKIP.has(s.name)) return true;
    console.log(`  -  ${s.name}.png (owned by another pass)`);
    return false;
  });

  for (const s of plan) {
    if (only.length && !only.includes(s.name)) continue;
    if (s.group !== group) {
      group = s.group;
      console.log(`\n${group}:`);
    }
    const skip = (reason) => {
      skipped.push({ name: s.name, reason, optional: !!s.optional });
      console.warn(`  ⚠  ${s.name}.png skipped: ${reason}`);
    };

    if ('base' in s && !s.base) {
      skip(s.why);
      continue;
    }
    try {
      const stable = await go(page, s.route, s.settle, s.base ? { base: s.base } : undefined);
      if (!stable) {
        skip('page never stopped loading — still showing a skeleton or the dev compile indicator');
        continue;
      }
      if (s.requireTab && !(await tabIsActive(page, s.requireTab))) {
        skip(s.why);
        continue;
      }
      if (s.requireText && !(await waitForTextPresent(page, s.requireText, s.waitTextTimeout))) {
        skip(`"${s.requireText}" never appeared — the feature this shot illustrates did not render`);
        continue;
      }
      if (s.waitTextGone && !(await waitForTextGone(page, s.waitTextGone, s.waitTextTimeout))) {
        // Shooting a stuck loading state is worse than shipping no shot: the
        // page would advertise the feature with a spinner. Report the budget
        // that actually applied — it is per-shot, not a fixed 60s.
        const waited = Math.round((s.waitTextTimeout ?? DEFAULT_TEXT_WAIT_MS) / 1000);
        skip(`never finished loading — still showing "${s.waitTextGone}" after ${waited}s`);
        continue;
      }
      await shoot(page, s.name);
    } catch (err) {
      // Not every throw is an Error. Reading .name/.message off a string or a
      // plain object would throw again *inside* the catch and take down the
      // whole run — the exact per-shot independence this loop exists to give.
      const detail = err instanceof Error
        ? `${err.name}: ${err.message.split('\n')[0]}`
        : `threw a non-Error: ${String(err).split('\n')[0]}`;
      skip(detail);
    }
  }

  await browser.close();

  if (skipped.length) {
    console.log(`\n⚠  Skipped ${skipped.length} shot(s):`);
    for (const s of skipped) console.log(`   - ${s.name} — ${s.reason}`);
  }
  console.log(`\nScreenshots saved to:\n  ${OUT}\n`);

  // A skipped shot leaves the previously committed PNG in place. For anything
  // site/index.html references, that means the page keeps publishing a stale
  // image while the run reports success — and this script is now part of
  // `capture:docs:prod`, so a silent exit 0 would let an orchestrator print
  // "Done" over images it never regenerated. Optional shots (see `optional`
  // above) are expected to skip and do not fail the run.
  const required = skipped.filter((s) => !s.optional);
  if (required.length) {
    console.error(
      `\n✗ ${required.length} published screenshot(s) could not be regenerated: ` +
      `${required.map((s) => s.name).join(', ')}\n` +
      `  The committed PNGs for these are unchanged and may now be stale.\n`,
    );
    process.exitCode = 1;
  }
})();
