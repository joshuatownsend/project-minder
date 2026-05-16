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
const OUT = join(__dirname, '..', 'site', 'screenshots');

async function shoot(page, name) {
  const dest = join(OUT, `${name}.png`);
  await page.screenshot({ path: dest, fullPage: false });
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

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  console.log('Capturing agents/skills/provenance screenshots...');

  // 1. Agents catalog — clean list view showing provenance badges across many rows
  await go(page, '/agents', 1200);
  await shoot(page, 'agents');

  // 2. Provenance detail — expand a marketplace row (3rd chevron = code-reviewer with
  //    claude-plugins-official badge) to show version, SHA, and per-row actions
  await page.locator('svg.lucide-chevron-right').nth(2).click();
  await page.waitForTimeout(800);
  await shoot(page, 'provenance');

  // 3. Skills catalog — clean list view showing version chips and update indicators
  await go(page, '/skills', 1200);
  await shoot(page, 'skills');

  await browser.close();
  console.log('\nDone.');
})();
