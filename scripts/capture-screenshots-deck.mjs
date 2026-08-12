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
const OUT = join(__dirname, '..', 'site', 'screenshots');

mkdirSync(OUT, { recursive: true });

async function shoot(page, name) {
  const dest = join(OUT, `${name}.png`);
  await page.screenshot({ path: dest, fullPage: false, timeout: 90000 });
  console.log(`  ✓  ${name}.png`);
}

// Same stability gate as capture-screenshots-extended.mjs: wait until the
// Next dev "Compiling…" pill and every .animate-pulse skeleton have been gone
// for ~1.5s sustained, via page-context JS so the wait stays bounded.
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

async function go(page, route, settle = 1000, { base = BASE, stableTimeout = 60000, postSettle = 4000 } = {}) {
  await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await hideTransientBanners(page);
  await page.waitForTimeout(settle);
  await waitForStableUI(page, { timeout: stableTimeout });
  await page.waitForTimeout(postSettle);
  // The banner mounts after a delay (it waits on its own fetch), so re-apply
  // once the page has settled or it reappears between the two waits.
  await hideTransientBanners(page);
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
    { group: 'Command Deck', name: 'github-activity', route: '/project/project-minder', settle: 2000 },
    // `optional` marks a shot site/index.html does not reference, so skipping
    // it is a normal outcome rather than a failure. Everything else is
    // published, and failing to regenerate a published shot must not exit 0 —
    // see the exit handling at the end of this file.
    { group: 'Command Deck', name: 'board', route: '/board', settle: 1500, base: DEMO_BASE, optional: true,
      why: 'set MINDER_CAPTURE_DEMO_BASE to a MINDER_DEMO=1 server (a real board is empty until you write BOARD.md)' },
    { group: 'Power tools', name: 'workflows', route: '/workflows', settle: 1200 },
    // No /instructions shot on purpose. That catalog is opt-in per harness and
    // renders an empty state until a Codex or Gemini adapter is enabled, so
    // capturing it costs time and leaves an orphan PNG that site/index.html
    // does not reference. Add it back only alongside prose that uses it.
    { group: 'Power tools', name: 'code-intel', route: '/project/project-minder?tab=hot-files', settle: 1500,
      requireTab: 'Hot Files', why: 'no Hot Files tab on project-minder',
      // The panel's own endpoints are slow on a large session index
      // (hot-files ~30s, file-coupling ~100s measured), so this wait needs a
      // budget well past the 60s default or the shot lands on the spinner.
      waitTextGone: 'Analyzing file activity', waitTextTimeout: 180000 },
    // /costs runs last: it is by far the slowest route, so a timeout here
    // costs nothing that has not already been captured.
    { group: 'Cost & time', name: 'timecard', route: '/timecard', settle: 1500 },
    { group: 'Cost & time', name: 'costs', route: '/costs', settle: 1200 },
  ];

  // MINDER_CAPTURE_ONLY=costs,timecard re-shoots a subset. /costs is slow
  // enough to time out intermittently, and re-running all seven shots to
  // recover one of them wastes several minutes of dev-server compile.
  const only = (process.env.MINDER_CAPTURE_ONLY || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  let group = null;
  for (const s of SHOTS) {
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
      await go(page, s.route, s.settle, s.base ? { base: s.base } : undefined);
      if (s.requireTab && !(await tabIsActive(page, s.requireTab))) {
        skip(s.why);
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
      skip(`${err.name}: ${err.message.split('\n')[0]}`);
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
