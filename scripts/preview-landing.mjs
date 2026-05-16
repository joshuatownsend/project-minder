// Quick local sanity check for site/index.html.
// Renders the file via file:// and takes:
//   - scripts/preview/landing-full.png   (full-page reference shot)
//   - scripts/preview/section-NN-*.png   (one viewport-sized shot per new
//                                          feature section so layout/text/
//                                          images can be eyeballed quickly)
//
// Usage: node scripts/preview-landing.mjs

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const INDEX = pathToFileURL(join(REPO_ROOT, 'site', 'index.html')).toString();
const OUT_DIR = join(__dirname, 'preview');

mkdirSync(OUT_DIR, { recursive: true });

// Section headings in document order — used to anchor scroll for spot-checks.
// Each entry produces one viewport-sized screenshot scrolled to that heading.
const SECTIONS = [
  { name: 'hero',                        heading: 'Project Minder' },
  { name: 'memory-observatory',          heading: 'Memory Observatory' },
  { name: 'multi-agent-coordination',    heading: 'Multi-Agent Coordination' },
  { name: 'templates-library',           heading: 'Templates' }, // matches "Templates & Library"
  { name: 'config-linting-security',     heading: 'Config Linting' },
  { name: 'session-quality',             heading: 'Session Quality' },
  { name: 'notifications-budgets',       heading: 'Notifications & Budgets' },
  { name: 'power-user-tools',            heading: 'Power-User Tools' },
  { name: 'quick-start',                 heading: 'Quick Start' },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const failedImages = [];
  page.on('response', (resp) => {
    const url = resp.url();
    if (/\.(png|jpg|jpeg|webp|svg)$/i.test(url) && resp.status() >= 400) {
      failedImages.push(`${resp.status()} ${url}`);
    }
  });

  console.log(`Loading: ${INDEX}`);
  await page.goto(INDEX, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // Full-page reference shot
  const fullDest = join(OUT_DIR, 'landing-full.png');
  await page.screenshot({ path: fullDest, fullPage: true, timeout: 30000 });
  console.log(`Wrote: ${fullDest}`);

  // Per-section spot-check shots
  for (let i = 0; i < SECTIONS.length; i++) {
    const s = SECTIONS[i];
    const dest = join(OUT_DIR, `section-${String(i).padStart(2, '0')}-${s.name}.png`);
    try {
      const heading = page.getByRole('heading', { name: s.heading, exact: false }).first();
      await heading.scrollIntoViewIfNeeded({ timeout: 2000 });
      // Nudge up a bit so the heading isn't pinned to the top of the viewport.
      await page.evaluate(() => window.scrollBy(0, -40));
      await page.waitForTimeout(200);
      await page.screenshot({ path: dest, fullPage: false, timeout: 15000 });
      console.log(`  ✓  ${s.name}`);
    } catch (err) {
      console.warn(`  ⚠  ${s.name}: ${err.message}`);
    }
  }

  if (failedImages.length) {
    console.log('\n⚠  Failed image responses:');
    for (const f of failedImages) console.log(`  - ${f}`);
  } else {
    console.log('\n✓ All image responses returned <400');
  }

  await browser.close();
})();
