import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:4100';
const OUT = join(__dirname, 'screenshots');

async function shoot(page, name) {
  const dest = join(OUT, `${name}.png`);
  await page.screenshot({ path: dest, fullPage: false });
  console.log(`  ✓  ${name}.png`);
}

async function go(page, route, settle = 800) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(settle);
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
