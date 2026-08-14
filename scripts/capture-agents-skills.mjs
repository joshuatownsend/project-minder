import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Default targets the dev server (port 4100). The prod-capture orchestrator
// overrides this with MINDER_CAPTURE_BASE to hit a prod-built server.
const BASE = process.env.MINDER_CAPTURE_BASE || 'http://localhost:4100';
// Write into site/screenshots/ so all gh-pages assets live in one directory.
// (Previously this script wrote to scripts/screenshots/ — a path mismatch with
// the other two capture scripts that prevented gh-pages from picking up agents
// /skills/provenance refreshes.)
// MINDER_CAPTURE_OUT lets the demo pass write to a temp dir instead of the live
// screenshot directory; MINDER_CAPTURE_DPR=2 is the resolution fix (see
// capture-screenshots.mjs for the rationale).
const OUT = process.env.MINDER_CAPTURE_OUT || join(__dirname, '..', 'site', 'screenshots');
const DPR = Number(process.env.MINDER_CAPTURE_DPR || 2);
// Nav timeout. 90s was too tight against a real index: /usage aggregates
// thousands of sessions server-side and blew that budget. The deck script
// already runs at 180s for the same reason.
const NAV_TIMEOUT = Number(process.env.MINDER_CAPTURE_NAV_TIMEOUT || 180000);

// Shots another pass owns (see capture-screenshots.mjs for why skipping the
// navigation matters, not just the file write).
const SKIP = new Set(
  (process.env.MINDER_CAPTURE_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean),
);



// All three shots here are published by site/index.html, so a failure must exit
// non-zero the way the other capture scripts do — otherwise the prod
// orchestrator reports a successful refresh while a stale image stays on the
// site.
const failures = [];

async function shoot(page, name) {
  const dest = join(OUT, `${name}.png`);
  // See capture-screenshots.mjs: 2x rasters exceed Playwright's 30s default,
  // and `animations: disabled` stops a continuously-polling panel from holding
  // the screenshot open.
  try {
    await page.screenshot({ path: dest, fullPage: false, timeout: 120000, animations: 'disabled', caret: 'hide' });
    console.log(`  ✓  ${name}.png`);
  } catch (err) {
    console.warn(`  ⚠  ${name}.png failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    failures.push(name);
  }
}

// Wait until every loading indicator has been gone for ~1.5s sustained.
//
// Gating on `.animate-pulse` + "Compiling" alone missed two of the app's four
// idioms (#445) — plain "Loading…"/"Connecting…" text, and the bespoke
// placeholder divs that carry no class and no text but do run an inline
// `animation: pulse …` (StatusDashboard.tsx:80). agents.png / skills.png /
// provenance.png are all published on the landing page, so the same detection
// that guards capture-screenshots.mjs applies here.
//
// KNOWN REMAINING GAP: on timeout this still accepts whatever is on screen
// rather than refusing the shot, so a genuinely slow page can still publish a
// loading state. The sibling scripts refuse instead. Closing that here means
// giving this script the same shoot()-level guard — tracked with #445.
// We run the check via waitForFunction (page-context JS, Playwright-enforced
// timeout) instead of locator polling — keeps the whole wait bounded and
// avoids the locator.count() hang we hit on stubborn pages.
async function waitForStableUI(page, { timeout = 25000 } = {}) {
  try {
    await page.waitForFunction(
      () => {
        const w = /** @type {any} */ (window);
        const now = Date.now();
        const text = document.body.innerText || '';
        const hasCompile = /Compiling/i.test(text);
        // Word boundaries, so "Reloading"/"Disconnecting" do not read as busy.
        const hasLoadingText = /\bLoading\b/i.test(text) || /\bConnecting\b/i.test(text);
        // Match the animation NAME: DashboardGrid.tsx:454 renders
        // `animation: loading ? "spin …" : "none"`, so a [style*="animation"]
        // selector would match the idle state and never settle.
        //
        // The 24px floor applies ONLY to inline pulses: GithubActivityStrip's
        // 7px CI dot pulses while a check RUNS, which is a settled state, and
        // treating it as loading pins this page at "busy" forever. The Tailwind
        // class needs no floor — `h-4` skeletons are only 16px tall.
        const hasSkeleton = document.querySelectorAll('.animate-pulse').length > 0
          || [...document.querySelectorAll('[style*="pulse"]')]
            .some((el) => el.getBoundingClientRect().height >= 24);
        if (hasCompile || hasLoadingText || hasSkeleton) {
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
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(settle);
  await waitForStableUI(page, { timeout: stableTimeout });
  await page.waitForTimeout(postSettle);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR });
  const page = await ctx.newPage();

  console.log('Capturing agents/skills/provenance screenshots...');

  // 1 & 2. Agents catalog, and the provenance detail that is captured FROM it.
  //
  // These share one navigation but are skipped independently: `provenance` is
  // not a demo-owned shot, so a run that skips `agents` must still visit
  // /agents to capture it — otherwise skipping one shot silently drops another
  // that no pass owns, and it is never captured at all.
  const wantAgents = !SKIP.has('agents');
  const wantProvenance = !SKIP.has('provenance');
  if (!wantAgents) console.log('  -  agents.png (owned by another pass)');
  if (!wantProvenance) console.log('  -  provenance.png (owned by another pass)');

  if (wantAgents || wantProvenance) {
    await go(page, '/agents', 1200);
    if (wantAgents) await shoot(page, 'agents');
    if (wantProvenance) {
      // Expand a marketplace row (3rd chevron = code-reviewer with the
      // claude-plugins-official badge) to show version, SHA, and per-row actions.
      try {
        await page.locator('svg.lucide-chevron-right').nth(2).click();
        await page.waitForTimeout(800);
        await shoot(page, 'provenance');
      } catch (err) {
        // The expanded row is what this shot is FOR, so a failed click means
        // the next line would capture the collapsed list under the provenance
        // name. Record it and skip — never shoot the wrong thing.
        console.warn(`  ⚠  provenance.png failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
        failures.push('provenance');
      }
    }
  }

  // 3. Skills catalog — clean list view showing version chips and update indicators
  if (SKIP.has('skills')) console.log('  -  skills.png (owned by another pass)');
  else {
    await go(page, '/skills', 1200);
    await shoot(page, 'skills');
  }

  await browser.close();
  console.log('\nDone.');

  if (failures.length) {
    console.error(
      `✗ ${failures.length} published shot(s) failed: ${failures.join(', ')}\n` +
      '  site/index.html references these, so the page still shows their previous version.',
    );
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('\n✗ capture-agents-skills failed:', err);
  process.exit(1);
});
