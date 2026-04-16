# GitHub Pages Landing Site — Design Spec

**Date:** 2026-04-16  
**Status:** Approved  
**Hosting:** `gh-pages` branch → `joshuatownsend.github.io/project-minder`

---

## Goal

A public-facing single-page site that showcases Project Minder's features and converts visitors into users. Audience is both Claude Code developers looking for a tool like this and the general dev community browsing the portfolio.

---

## Tech Approach

Plain HTML + CSS. No build step, no JS/CSS framework, no CDN-hosted stylesheets or scripts. One `index.html`, one `style.css`. Badge images are fetched from `img.shields.io` (external image host, not a framework CDN). Screenshots committed directly alongside the HTML in `site/screenshots/`.

**Visual style:** Dark background (`#0a0a0a`), amber accent (`#f59e0b`), card-style screenshot frames with subtle border + shadow. Mirrors Project Minder's own dark UI so screenshots feel native to the page.

---

## Page Structure

Single scrolling page with these sections in order:

### 1. Hero
- Project name + tagline: *"A local-only dev dashboard that auto-scans your projects and surfaces the context you need — without leaving your browser."*
- Badge row: Node ≥20.19, MIT license, Next.js 16 + TypeScript
- Two CTAs: `View on GitHub` (links to repo) and `Quick Start ↓` (anchor-scrolls to Quick Start section)
- Hero image: full-width dashboard screenshot with rounded corners and amber glow border

### 2. Feature Groups
Four thematic groups, each with: a section heading, 2–3 sentence description, and a screenshot.

| Group | Description focus | Screenshot |
|---|---|---|
| Dashboard & Scanning | Auto-scanning, git dirty status, search/filter/sort | `dashboard.png` |
| Claude Code Integration | Sessions browser, insights extraction, token cost analytics | `sessions-browser.png`, `insights-browser.png`, `usage-dashboard.png` |
| Project Management | TODO tracking, manual steps tracker, worktree overlay | `manual-steps.png`, `worktrees.png` |
| Observability & Setup | Stats dashboard, dev server control, setup guide | `stats-dashboard.png`, `setup.png` |

Each group renders as: heading + description on the left, primary screenshot on the right (alternating left/right on wider screens for visual rhythm). Secondary screenshots within a group are displayed as smaller stacked thumbnails beneath the primary image.

Primary screenshot per group:
- Dashboard & Scanning → `dashboard.png` (secondary: `card-detail.png`)
- Claude Code Integration → `sessions-browser.png` (secondary: `session-detail.png`, `insights-browser.png`, `usage-dashboard.png`)
- Project Management → `manual-steps.png` (secondary: `worktrees.png`)
- Observability & Setup → `stats-dashboard.png` (secondary: `setup.png`, `config.png`)

`project-detail.png` is used in the Dashboard & Scanning group description as a secondary image to show the dev server control panel on the Overview tab.

### 3. Quick Start
Anchor target for the hero CTA. Shows the 5-step install sequence in a styled dark code block:

```
git clone https://github.com/joshuatownsend/project-minder.git
cd project-minder
npm install
# configure .minder.json with your devRoots
npm run dev   # open http://localhost:4100
```

A note below: "Prerequisites: Node.js ≥ 20.19, Windows (uses Windows paths and taskkill)"

### 4. Inspired By
Small credit row with four linked items matching the README's Inspired By section:
- CodeBurn, Sniffly, claude-code-karma, raphi011's insights gist

### 5. Footer
- MIT © Josh Townsend
- GitHub repo link

---

## Screenshots (12 total)

Captured by `scripts/capture-screenshots.mjs` at **1440×900** viewport, saved to `site/screenshots/`.

| File | Route | Notes |
|---|---|---|
| `dashboard.png` | `/` | Full page, wait for project cards to render |
| `project-detail.png` | `/project/[slug]` | Overview tab, use `project-minder` slug |
| `sessions-browser.png` | `/sessions` | Full page |
| `session-detail.png` | `/sessions/[sessionId]` | First session from the browser |
| `insights-browser.png` | `/insights` | Full page |
| `usage-dashboard.png` | `/usage` | Full page, default period |
| `stats-dashboard.png` | `/stats` | Full page |
| `manual-steps.png` | `/manual-steps` | Full page |
| `worktrees.png` | `/project/[slug]` | TODOs tab with worktree section expanded, use active worktree if present |
| `setup.png` | `/setup` | Full page |
| `config.png` | `/config` | Full page |
| `card-detail.png` | `/` | Clipped `element.screenshot()` of a single project card, use `project-minder` slug |

---

## Playwright Capture Script

**File:** `scripts/capture-screenshots.mjs` (committed to `main`)

**Behavior:**
1. Launches headed Chromium at `http://localhost:4100` (user runs `npm run dev` first)
2. Navigates to each route, waits for `networkidle` + 500ms settle
3. For detail pages, uses known slugs: project = `project-minder`, session = first item from `/api/sessions`
4. For the card detail shot: queries `a[href="/project/project-minder"]` and calls `element.screenshot()`
5. Outputs all files to `site/screenshots/`
6. Logs each captured file path on completion

**Dependencies:** Uses `playwright` package. Added as a dev dependency.

---

## `gh-pages` Branch Structure

Orphan branch. Root contains:

```
index.html
style.css
screenshots/
  dashboard.png
  project-detail.png
  sessions-browser.png
  session-detail.png
  insights-browser.png
  usage-dashboard.png
  stats-dashboard.png
  manual-steps.png
  worktrees.png
  setup.png
  config.png
  card-detail.png
```

---

## Deployment Workflow (Manual)

1. Run `npm run dev` in the project-minder repo
2. Run `node scripts/capture-screenshots.mjs` — outputs to `site/screenshots/`
3. Switch to `gh-pages` branch
4. Copy updated `screenshots/` + any `index.html`/`style.css` changes
5. Commit and push — GitHub Pages serves automatically

**One-time GitHub repo setting required:** Repo Settings → Pages → Source: "Deploy from a branch" → Branch: `gh-pages`, Folder: `/ (root)`

---

## Out of Scope

- CI/CD automation for screenshot recapture
- Dark/light theme toggle on the landing page
- Analytics or tracking scripts
- Any server-side rendering or build pipeline
