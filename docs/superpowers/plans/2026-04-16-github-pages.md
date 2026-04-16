# GitHub Pages Landing Site — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public-facing GitHub Pages site at `joshuatownsend.github.io/project-minder` — plain HTML/CSS with 12 Playwright-captured screenshots — that showcases Project Minder's features and converts visitors into users.

**Architecture:** A `scripts/capture-screenshots.mjs` script (on `main`) navigates the running local app at `localhost:4100` and saves 12 screenshots to `site/screenshots/`, co-located with the HTML. A `site/` directory (also on `main`) contains `index.html`, `style.css`, and `screenshots/`. Deploying means creating/updating the orphan `gh-pages` branch with the contents of `site/`.

**Tech Stack:** Playwright (Chromium, `headless: false` so you can watch progress), plain HTML5, plain CSS3 (no preprocessor, no JS/CSS framework CDN). Badge images are fetched from `img.shields.io`. Node.js ESM script (`*.mjs`).

---

## File Map

| File | Branch | Action |
|------|--------|--------|
| `scripts/capture-screenshots.mjs` | `main` | Create |
| `site/index.html` | `main` | Create |
| `site/style.css` | `main` | Create |
| `site/screenshots/*.png` | `main` | Created by capture script |
| `package.json` | `main` | Modify — add `playwright` devDependency |
| `index.html` | `gh-pages` | Copied from `site/index.html` |
| `style.css` | `gh-pages` | Copied from `site/style.css` |
| `screenshots/*.png` | `gh-pages` | Copied from `site/screenshots/` |

---

## Task 1: Install Playwright

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install playwright as a dev dependency**

```bash
npm install --save-dev playwright
```

Expected output includes: `added N packages` with `playwright` listed.

- [ ] **Step 2: Install the Chromium browser**

```bash
npx playwright install chromium
```

Expected: downloads Chromium (~150 MB). Takes 1-2 minutes. No errors.

- [ ] **Step 3: Verify installation**

```bash
node -e "const { chromium } = require('playwright'); console.log('playwright OK:', chromium.name())"
```

Expected output: `playwright OK: chromium`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add playwright dev dependency for screenshot capture"
```

---

## Task 2: Write the Playwright Capture Script

**Files:**
- Create: `scripts/capture-screenshots.mjs`

`scripts/` already exists (contains `import-insights.ts`). No mkdir needed.

- [ ] **Step 1: Create the script**

Create `scripts/capture-screenshots.mjs` with this exact content:

```mjs
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
  const resp = await page.goto(`${BASE}/api/sessions`);
  const sessions = await resp.json();
  const firstSessionId = sessions[0]?.sessionId ?? null;
  if (!firstSessionId) {
    console.warn('  ⚠  No sessions found — session-detail screenshot will be skipped');
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
```

- [ ] **Step 2: Commit**

```bash
git add scripts/capture-screenshots.mjs
git commit -m "feat: add Playwright screenshot capture script"
```

---

## Task 3: Run the Capture Script

**Files:**
- Creates: `site/screenshots/*.png` (up to 12 files)

Prerequisite: `npm run dev` must be running in a separate terminal on port 4100.

- [ ] **Step 1: Start the dev server (separate terminal)**

```bash
npm run dev
```

Wait until you see `✓ Ready in Xms` and the dashboard loads at http://localhost:4100.

- [ ] **Step 2: Run the capture script**

```bash
node scripts/capture-screenshots.mjs
```

A headed Chromium window will open and navigate through all routes automatically. Expected terminal output:

```
Fetching first session ID...

Capturing screenshots...
  ✓  dashboard.png
  ✓  project-detail.png
  ✓  sessions-browser.png
  ✓  session-detail.png
  ✓  insights-browser.png
  ✓  usage-dashboard.png
  ✓  stats-dashboard.png
  ✓  manual-steps.png
  ✓  worktrees.png
  ✓  setup.png
  ✓  config.png
  ✓  card-detail.png

All screenshots saved to:
  C:\dev\project-minder\site\screenshots
```

- [ ] **Step 3: Verify output**

```bash
ls site/screenshots/
```

Expected: 12 `.png` files (11 if no sessions exist — `session-detail.png` is skipped with a warning).

Open a few PNGs in an image viewer and confirm they show real UI, not blank pages or error states.

- [ ] **Step 4: Commit screenshots**

```bash
git add site/screenshots/
git commit -m "chore: add captured screenshots for GitHub Pages site"
```

---

## Task 4: Write `site/index.html`

**Files:**
- Create: `site/index.html`

- [ ] **Step 1: Create the file**

Create `site/index.html` with this exact content:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Project Minder — Local Dev Dashboard for Claude Code Users</title>
  <meta name="description" content="A local-only dev dashboard that auto-scans your projects and surfaces the context you need — git status, Claude Code sessions, TODOs, costs, and more.">
  <link rel="stylesheet" href="style.css">
</head>
<body>

  <!-- ── Hero ─────────────────────────────────────────────── -->
  <section class="hero">
    <div class="container">
      <div class="hero-content">
        <h1>Project Minder</h1>
        <p class="tagline">A local-only dev dashboard that auto-scans your projects and surfaces the context you need — without leaving your browser.</p>
        <div class="badges">
          <img src="https://img.shields.io/badge/node-%3E%3D20.19-brightgreen" alt="Node ≥20.19">
          <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
          <img src="https://img.shields.io/badge/stack-Next.js%2016%20%2B%20TypeScript-black" alt="Next.js 16 + TypeScript">
        </div>
        <div class="ctas">
          <a href="https://github.com/joshuatownsend/project-minder" class="btn btn-primary">View on GitHub</a>
          <a href="#quick-start" class="btn btn-ghost">Quick Start ↓</a>
        </div>
      </div>
      <div class="hero-shot">
        <img src="screenshots/dashboard.png" alt="Project Minder dashboard showing projects with git status, sessions, and todo counts" class="hero-img">
      </div>
    </div>
  </section>

  <!-- ── Feature Groups ────────────────────────────────────── -->
  <section class="features">
    <div class="container">

      <!-- Dashboard & Scanning -->
      <div class="feature-row">
        <div class="feature-text">
          <h2>Dashboard &amp; Scanning</h2>
          <p>Auto-scans your dev directories in parallel and renders every project as a card — git branch, dirty-file count, tech stack, and status at a glance. Background git checks populate amber <code>+N</code> indicators as results arrive. Search, filter by status, and sort across all projects in seconds.</p>
          <div class="secondary-shots">
            <img src="screenshots/card-detail.png" alt="Project card detail showing git dirty indicator and badges">
            <img src="screenshots/project-detail.png" alt="Project detail overview with dev server control">
          </div>
        </div>
        <div class="feature-shot">
          <img src="screenshots/dashboard.png" alt="Dashboard view" class="shot">
        </div>
      </div>

      <!-- Claude Code Integration -->
      <div class="feature-row feature-row--flip">
        <div class="feature-text">
          <h2>Claude Code Integration</h2>
          <p>Browse every Claude Code session with search, duration, token counts, and live-session indicators. Drill into a session for the full timeline, tool usage, file operations, and subagent tracking. <em>Insights extraction</em> scrapes <code>★ Insight</code> blocks from conversation history into searchable per-project files. The Usage dashboard breaks down token spend by model, project, and 13 activity categories with CSV/JSON export.</p>
          <div class="secondary-shots">
            <img src="screenshots/session-detail.png" alt="Session detail with timeline and tool usage">
            <img src="screenshots/insights-browser.png" alt="Cross-project insights browser">
            <img src="screenshots/usage-dashboard.png" alt="Token usage analytics dashboard">
          </div>
        </div>
        <div class="feature-shot">
          <img src="screenshots/sessions-browser.png" alt="Sessions browser" class="shot">
        </div>
      </div>

      <!-- Project Management -->
      <div class="feature-row">
        <div class="feature-text">
          <h2>Project Management</h2>
          <p>TODO tracking reads each project's <code>TODO.md</code> — add items inline or via a cross-project Quick Add modal (<kbd>Shift+T</kbd>). The Manual Steps tracker surfaces <code>MANUAL_STEPS.md</code> entries across all projects with interactive checkboxes that toggle on disk. A file watcher fires toast and OS notifications when Claude adds new steps mid-session. Worktree overlay surfaces TODOs, Manual Steps, and Insights from active Claude Code worktrees.</p>
          <div class="secondary-shots">
            <img src="screenshots/worktrees.png" alt="Worktree overlay showing active branch items">
          </div>
        </div>
        <div class="feature-shot">
          <img src="screenshots/manual-steps.png" alt="Manual steps dashboard" class="shot">
        </div>
      </div>

      <!-- Observability & Setup -->
      <div class="feature-row feature-row--flip">
        <div class="feature-text">
          <h2>Observability &amp; Setup</h2>
          <p>The Stats dashboard gives a portfolio-wide overview: tech stack distribution, project health, and Claude Code usage across all sessions. Dev server control lets you start, stop, and restart managed servers from the UI with live stdout/stderr output. The Setup guide provides copy-paste CLAUDE.md instruction blocks and Claude Code hooks — apply them to any managed project with one click.</p>
          <div class="secondary-shots">
            <img src="screenshots/setup.png" alt="Setup guide page">
            <img src="screenshots/config.png" alt="Config page with multiple scan roots">
          </div>
        </div>
        <div class="feature-shot">
          <img src="screenshots/stats-dashboard.png" alt="Stats dashboard" class="shot">
        </div>
      </div>

    </div>
  </section>

  <!-- ── Quick Start ────────────────────────────────────────── -->
  <section class="quick-start" id="quick-start">
    <div class="container">
      <h2>Quick Start</h2>
      <pre class="code-block"><code>git clone https://github.com/joshuatownsend/project-minder.git
cd project-minder
npm install
<span class="cmt"># create .minder.json in the repo root:</span>
<span class="cmt"># { "devRoots": ["C:\\dev"] }</span>
npm run dev   <span class="cmt"># open http://localhost:4100</span></code></pre>
      <p class="prereqs"><strong>Prerequisites:</strong> Node.js ≥ 20.19 &nbsp;·&nbsp; Windows (uses Windows paths and <code>taskkill</code>)</p>
    </div>
  </section>

  <!-- ── Inspired By ────────────────────────────────────────── -->
  <section class="inspired">
    <div class="container">
      <h3 class="inspired-heading">Inspired By</h3>
      <ul class="inspired-list">
        <li><a href="https://github.com/AgentSeal/codeburn" target="_blank" rel="noopener">CodeBurn</a> — token cost analytics design</li>
        <li><a href="https://github.com/chiphuyen/sniffly" target="_blank" rel="noopener">Sniffly</a> — stats dashboard concept</li>
        <li><a href="https://github.com/JayantDevkar/claude-code-karma" target="_blank" rel="noopener">claude-code-karma</a> — sessions browser concept</li>
        <li><a href="https://gist.github.com/raphi011/dc96edf80b0db8584527fefc6a3b4bd0" target="_blank" rel="noopener">raphi011's insights gist</a> — insights extraction concept</li>
      </ul>
    </div>
  </section>

  <!-- ── Footer ─────────────────────────────────────────────── -->
  <footer>
    <div class="container footer-inner">
      <span>MIT © Josh Townsend</span>
      <a href="https://github.com/joshuatownsend/project-minder" target="_blank" rel="noopener">GitHub →</a>
    </div>
  </footer>

</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add site/index.html
git commit -m "feat: add GitHub Pages index.html"
```

---

## Task 5: Write `site/style.css`

**Files:**
- Create: `site/style.css`

- [ ] **Step 1: Create the file**

Create `site/style.css` with this exact content:

```css
/* ── Reset ─────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/* ── Design Tokens ─────────────────────────────────────── */
:root {
  --bg:         #0a0a0a;
  --bg-card:    #111111;
  --bg-code:    #0d0d0d;
  --border:     #1e1e1e;
  --border-mid: #2a2a2a;
  --text:       #e5e5e5;
  --muted:      #888888;
  --amber:      #f59e0b;
  --amber-dim:  rgba(245, 158, 11, 0.12);
  --amber-glow: rgba(245, 158, 11, 0.25);
  --r:          10px;
  --mono:       'Menlo', 'Consolas', 'Liberation Mono', monospace;
  --max:        1100px;
}

/* ── Base ───────────────────────────────────────────────── */
html { scroll-behavior: smooth; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 16px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}

img { display: block; max-width: 100%; height: auto; }

a { color: var(--amber); text-decoration: none; }
a:hover { text-decoration: underline; }

code, kbd { font-family: var(--mono); font-size: 0.85em; }

code {
  background: var(--amber-dim);
  color: var(--amber);
  padding: 0.1em 0.38em;
  border-radius: 3px;
}

kbd {
  background: var(--bg-card);
  border: 1px solid var(--border-mid);
  padding: 0.1em 0.38em;
  border-radius: 3px;
  color: var(--text);
}

/* ── Layout ─────────────────────────────────────────────── */
.container {
  max-width: var(--max);
  margin: 0 auto;
  padding: 0 24px;
}

/* ── Hero ───────────────────────────────────────────────── */
.hero {
  padding: 72px 0 48px;
  text-align: center;
}

.hero .container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 40px;
}

.hero-content { max-width: 640px; }

.hero h1 {
  font-size: clamp(2.25rem, 6vw, 3.75rem);
  font-weight: 700;
  letter-spacing: -0.025em;
  color: #fff;
  line-height: 1.1;
}

.tagline {
  margin-top: 16px;
  font-size: 1.125rem;
  color: var(--muted);
  line-height: 1.7;
}

.badges {
  display: flex;
  gap: 8px;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 24px;
}
.badges img { height: 20px; display: inline; }

.ctas {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 28px;
}

.btn {
  display: inline-flex;
  align-items: center;
  padding: 10px 22px;
  border-radius: 6px;
  font-size: 0.9375rem;
  font-weight: 500;
  transition: opacity 0.15s, border-color 0.15s, color 0.15s;
  cursor: pointer;
}
.btn:hover { text-decoration: none; }

.btn-primary { background: var(--amber); color: #000; }
.btn-primary:hover { opacity: 0.88; }

.btn-ghost { color: var(--text); border: 1px solid var(--border-mid); }
.btn-ghost:hover { border-color: var(--amber); color: var(--amber); }

.hero-shot { width: 100%; }

.hero-img {
  width: 100%;
  border-radius: var(--r);
  border: 1px solid var(--amber-glow);
  box-shadow:
    0 0 0 1px var(--amber-dim),
    0 0 48px var(--amber-dim),
    0 24px 64px rgba(0, 0, 0, 0.85);
}

/* ── Feature Groups ─────────────────────────────────────── */
.features { padding: 32px 0 96px; }

.features .container {
  display: flex;
  flex-direction: column;
  gap: 80px;
}

.feature-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 48px;
  align-items: start;
}

/* Flip layout: text right, screenshot left */
.feature-row--flip { direction: rtl; }
.feature-row--flip > * { direction: ltr; }

.feature-text h2 {
  font-size: 1.5rem;
  font-weight: 600;
  color: #fff;
  letter-spacing: -0.015em;
  margin-bottom: 12px;
}

.feature-text p {
  font-size: 0.9375rem;
  color: var(--muted);
  line-height: 1.75;
}

.secondary-shots {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 20px;
}

.secondary-shots img {
  border-radius: 6px;
  border: 1px solid var(--border);
  opacity: 0.65;
  transition: opacity 0.2s, border-color 0.2s;
}
.secondary-shots img:hover { opacity: 1; border-color: var(--border-mid); }

/* Sticky primary screenshot — scrolls away at viewport top */
.feature-shot {
  position: sticky;
  top: 24px;
}

.shot {
  width: 100%;
  border-radius: var(--r);
  border: 1px solid var(--border-mid);
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.7);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.shot:hover {
  border-color: var(--amber-glow);
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.7), 0 0 20px var(--amber-dim);
}

/* ── Quick Start ────────────────────────────────────────── */
.quick-start {
  background: var(--bg-card);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  padding: 64px 0;
}

.quick-start h2 {
  font-size: 1.625rem;
  font-weight: 600;
  color: #fff;
  letter-spacing: -0.015em;
  margin-bottom: 24px;
}

.code-block {
  background: var(--bg-code);
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 20px 24px;
  font-family: var(--mono);
  font-size: 0.875rem;
  line-height: 1.8;
  color: var(--text);
  overflow-x: auto;
  white-space: pre;
}
.cmt { color: var(--muted); }

.prereqs {
  margin-top: 16px;
  font-size: 0.875rem;
  color: var(--muted);
}

/* ── Inspired By ────────────────────────────────────────── */
.inspired {
  padding: 48px 0;
  border-bottom: 1px solid var(--border);
}

.inspired-heading {
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--muted);
  margin-bottom: 14px;
}

.inspired-list {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  column-gap: 28px;
  row-gap: 6px;
}

.inspired-list li { font-size: 0.875rem; color: var(--muted); }
.inspired-list a { color: var(--muted); }
.inspired-list a:hover { color: var(--amber); text-decoration: none; }

/* ── Footer ─────────────────────────────────────────────── */
footer { padding: 24px 0; }

.footer-inner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.875rem;
  color: var(--muted);
}

/* ── Responsive ─────────────────────────────────────────── */
@media (max-width: 720px) {
  .feature-row,
  .feature-row--flip {
    grid-template-columns: 1fr;
    direction: ltr;
    gap: 28px;
  }
  .feature-row--flip .feature-shot { order: -1; }
  .feature-shot { position: static; }
  .hero { padding: 48px 0 32px; }
}
```

- [ ] **Step 2: Commit**

```bash
git add site/style.css
git commit -m "feat: add GitHub Pages stylesheet"
```

---

## Task 6: Local Preview

Verify the site looks correct before deploying. No code changes — just inspection.

- [ ] **Step 1: Open `site/index.html` in a browser**

Screenshots are already co-located at `site/screenshots/` — no copy step needed.

```bash
start site/index.html
```

Check visually:
- Hero: title, tagline, badges, two CTA buttons, dashboard screenshot with amber glow border
- 4 feature groups alternating left/right, each with a primary screenshot and smaller secondary shots
- Quick Start code block with muted comment lines
- Inspired By credits row
- Footer with GitHub link

- [ ] **Step 2: If anything looks wrong, fix `site/index.html` or `site/style.css` and re-open**

Common issues to look for:
- Screenshots not loading (verify `site/screenshots/*.png` files exist)
- Layout breaking at the default browser window width (resize to ~1440px)
- `feature-row--flip` not alternating direction (check `direction: rtl` in CSS)

- [ ] **Step 3: (no cleanup needed — screenshots live in `site/screenshots/` permanently)**

```bash
- [ ] **Step 4: Commit any fixes from Step 2 (if needed)**

```bash
git add site/
git commit -m "fix: adjust landing page layout after local preview"
```

---

## Task 7: Create `gh-pages` Branch and Deploy

**Files — gh-pages branch:**
- Create (orphan): `index.html`, `style.css`, `screenshots/*.png`

- [ ] **Step 1: Create the orphan `gh-pages` branch**

```bash
git checkout --orphan gh-pages
git rm -rf .
```

The working directory is now empty. You are on the `gh-pages` branch with no history.

- [ ] **Step 2: Copy the site files into the working tree root**

Use absolute paths — the working directory may have shifted when you switched branches.
Screenshots are co-located in `site/screenshots/`, so a single copy covers everything:

```bash
cp C:/dev/project-minder/site/index.html .
cp C:/dev/project-minder/site/style.css .
cp -r C:/dev/project-minder/site/screenshots screenshots
```

- [ ] **Step 3: Verify the files are present**

```bash
ls
```

Expected:
```
index.html   screenshots/   style.css
```

```bash
ls screenshots/
```

Expected: 11–12 `.png` files.

- [ ] **Step 4: Add a minimal `.gitignore` so Node artifacts can't accidentally land here**

```bash
echo "node_modules/" > .gitignore
```

- [ ] **Step 5: Commit everything**

```bash
git add index.html style.css screenshots/ .gitignore
git commit -m "feat: initial GitHub Pages site with screenshots"
```

- [ ] **Step 6: Push the `gh-pages` branch**

```bash
git push origin gh-pages
```

- [ ] **Step 7: Return to `main`**

```bash
git checkout main
```

---

## Task 8: Log Manual Steps for GitHub Pages Settings

The GitHub Pages source must be configured in the repo settings — this can't be done from the code.

- [ ] **Step 1: Append to MANUAL_STEPS.md**

Add this entry to `MANUAL_STEPS.md` in the project root:

```
## 2026-04-16 | github-pages | Enable GitHub Pages from gh-pages branch

- [ ] Go to https://github.com/joshuatownsend/project-minder/settings/pages
- [ ] Under "Build and deployment" → Source, select "Deploy from a branch"
- [ ] Branch: gh-pages, Folder: / (root)
- [ ] Click Save
  Site will be live at https://joshuatownsend.github.io/project-minder within ~1 minute

---
```

- [ ] **Step 2: Commit MANUAL_STEPS.md**

```bash
git add MANUAL_STEPS.md
git commit -m "chore: log manual step for GitHub Pages settings"
```

---

## Updating Screenshots in the Future

When you want to refresh screenshots after UI changes:

1. `npm run dev` (in one terminal)
2. `node scripts/capture-screenshots.mjs`
3. Review the new PNGs in `site/screenshots/`
4. `git checkout gh-pages`
5. `cp C:/dev/project-minder/site/screenshots/*.png screenshots/`
6. `git add screenshots/ && git commit -m "chore: refresh screenshots"`
7. `git push origin gh-pages`
8. `git checkout main`
