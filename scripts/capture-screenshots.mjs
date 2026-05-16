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
const OUT  = join(__dirname, '..', 'site', 'screenshots');

mkdirSync(OUT, { recursive: true });

async function shoot(page, name, { selector } = {}) {
  const dest = join(OUT, `${name}.png`);
  if (selector) {
    const el = await page.waitForSelector(selector);
    await el.screenshot({ path: dest });
  } else {
    await page.screenshot({ path: dest, fullPage: false });
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

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx     = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page    = await ctx.newPage();

  console.log('Fetching first session ID...');
  let firstSessionId = null;
  const resp = await page.goto(`${BASE}/api/sessions`);
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

  console.log('\nCapturing screenshots...');

  // 1. Dashboard — full viewport
  await go(page, '/');
  await shoot(page, 'dashboard');

  // 2. Project detail — Overview tab
  await go(page, '/project/project-minder', 900);
  await shoot(page, 'project-detail');

  // 3. Sessions browser
  await go(page, '/sessions');
  await shoot(page, 'sessions-browser');

  // 4. Session detail (skipped if no sessions)
  if (firstSessionId) {
    await go(page, `/sessions/${firstSessionId}`, 900);
    await shoot(page, 'session-detail');
  }

  // 5. Insights browser
  await go(page, '/insights');
  await shoot(page, 'insights-browser');

  // 6. Usage dashboard
  await go(page, '/usage', 900);
  await shoot(page, 'usage-dashboard');

  // 7. Stats dashboard
  await go(page, '/stats', 900);
  await shoot(page, 'stats-dashboard');

  // 8. Manual steps
  await go(page, '/manual-steps');
  await shoot(page, 'manual-steps');

  // 9. TODOs tab — project detail, TODOs tab. (Previously misnamed "worktrees" —
  // a separate real-worktree-overlay shot remains a follow-up; see TODO.md.)
  await go(page, '/project/project-minder', 900);
  try {
    await page.getByRole('tab', { name: 'TODOs' }).click();
    await page.waitForTimeout(400);
  } catch { /* tab absent or already active — screenshot whatever is visible */ }
  await shoot(page, 'todos-tab');

  // 10. Setup page
  await go(page, '/setup');
  await shoot(page, 'setup');

  // 11. Config page
  await go(page, '/config');
  await shoot(page, 'config');

  // 12. System Status page — live cross-project session bucket view
  await go(page, '/status', 1200);
  await shoot(page, 'status');

  // 13. Memory tab on project detail — MEMORY.md overview
  await go(page, '/project/project-minder?tab=memory', 1200);
  await shoot(page, 'memory');

  // 14. Card detail — element screenshot of the project-minder card link
  await go(page, '/');
  await shoot(page, 'card-detail', { selector: 'a[href="/project/project-minder"]' });

  await browser.close();
  console.log(`\nAll screenshots saved to:\n  ${OUT}\n`);
})();
