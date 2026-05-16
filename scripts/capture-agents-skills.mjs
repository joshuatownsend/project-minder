import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:4100';
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

// Next.js dev mode renders a "Compiling..." pill in the bottom-right
// while a route compiles. Screenshotting before it disappears yields
// a skeleton-only frame. Wait for it to be hidden before continuing.
async function waitForCompile(page) {
  try {
    const indicator = page.locator('text=/Compiling/i').first();
    if (await indicator.isVisible({ timeout: 500 }).catch(() => false)) {
      await indicator.waitFor({ state: 'hidden', timeout: 90000 });
    }
  } catch {
    // Indicator absent or already gone — no-op
  }
}

// Project Minder's UI uses .animate-pulse skeleton placeholders while data
// loads. Capturing before they clear yields a content-less frame. Wait for
// all skeletons to disappear (with a 20s budget — if data is genuinely
// missing we accept the skeleton frame as the honest empty state).
async function waitForSkeletons(page) {
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('.animate-pulse').length === 0,
      null,
      { timeout: 20000 }
    );
  } catch {
    // Skeletons may persist if data is genuinely loading slowly — proceed.
  }
}

async function go(page, route, settle = 1500) {
  // domcontentloaded + settle is more reliable than networkidle for this app:
  // background polling (git status, sessions, OTEL) keeps the network busy
  // and would otherwise time out the 30s networkidle wait.
  // 90s timeout absorbs Next.js dev's first-compile cost for heavy routes.
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(settle);
  await waitForCompile(page);
  await waitForSkeletons(page);
  await page.waitForTimeout(400); // brief final settle after data arrives
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
