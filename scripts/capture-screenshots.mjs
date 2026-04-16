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
  if (selector) {
    const el = await page.waitForSelector(selector);
    await el.screenshot({ path: dest });
  } else {
    await page.screenshot({ path: dest, fullPage: false });
  }
  console.log(`  ✓  ${name}.png`);
}

async function go(page, route, settle = 600) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(settle);
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

  // 9. Worktrees — project detail, TODOs tab
  await go(page, '/project/project-minder', 900);
  try {
    await page.getByRole('tab', { name: 'TODOs' }).click();
    await page.waitForTimeout(400);
  } catch { /* tab absent or already active — screenshot whatever is visible */ }
  await shoot(page, 'worktrees');

  // 10. Setup page
  await go(page, '/setup');
  await shoot(page, 'setup');

  // 11. Config page
  await go(page, '/config');
  await shoot(page, 'config');

  // 12. Card detail — element screenshot of the project-minder card link
  await go(page, '/');
  await shoot(page, 'card-detail', { selector: 'a[href="/project/project-minder"]' });

  await browser.close();
  console.log(`\nAll screenshots saved to:\n  ${OUT}\n`);
})();
