# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.9.3] - 2026-04-16

### Added
- Minimal GitHub Actions CI workflow (`.github/workflows/ci.yml`) running lint, tests, and build on every PR and push to `main`.
- TODO items in the project detail TODO tab are now interactive: click any item to toggle it done/undone. Changes are written back to `TODO.md` immediately.

### Changed
- Branch protection: `main` now requires PRs, linear history, force-pushes and deletions blocked. Squash is the only merge style. The `verify` CI status check will be added as a required check once the initial workflow run completes on `main`.

## [0.9.2] - 2026-04-16

### Added
- **Cross-platform support (macOS + Linux)** — Project Minder now runs on macOS and Linux in addition to Windows. A new `src/lib/platform.ts` module centralizes all platform-specific logic: process spawning (`cmd.exe /c` on Windows, direct binary with process group on Unix), process tree termination (`taskkill` on Windows, negative-PID SIGTERM on Unix), `node_modules/.bin` binary paths (`.cmd` extension on Windows, extensionless on Unix), clean spawn environment variables (platform-appropriate sets), and default dev root (`C:\dev` on Windows, `~/dev` on Unix). Claude Code path encoding/decoding updated to handle both Windows (`C--dev-foo`) and Unix (`-home-user-dev-foo`) directory name formats.
- **Unit tests for `setupApply.ts`** — 10 tests covering all four apply scenarios: initial apply (creates files), re-apply (idempotency), malformed `settings.local.json` (throws with message), and partial hook presence (merges only missing commands). Uses real temp-dir fixtures via `os.tmpdir()` / `fs.mkdtemp` for full filesystem fidelity.

## [0.9.1] - 2026-04-16

### Added
- **GitHub Pages landing site** — Public-facing site at `joshuatownsend.github.io/project-minder` with hero, four feature-group sections, quick-start instructions, and 12 Playwright-captured screenshots. Plain HTML/CSS, dark theme matching the app's own aesthetic.
- **Screenshot capture script** — `scripts/capture-screenshots.mjs` navigates the running app at 1440×900 and saves all 12 screenshots to `site/screenshots/` in one command.

### Added
- **Setup Guide — Apply to project** — The `/setup` page now includes an "Apply to a Project" panel. Pick any managed project from a dropdown, choose which steps to apply (CLAUDE.md instructions and/or Claude Code hooks), and Project Minder writes the files directly. Idempotent: blocks already present are skipped; existing files are backed up to `.minder-bak` before any modification. New `POST /api/setup/[slug]` endpoint with `action: "claude-md" | "hooks" | "both"`.
- **Setup Guide** — New `/setup` page (nav link: Setup) with copy-paste instructions for configuring projects to work with Project Minder. Structured as two sequential steps: Step 1 (CLAUDE.md instruction blocks, required) tells Claude when and how to write these files; Step 2 (Claude Code `PreToolUse` hooks, optional) adds format enforcement on top. Includes a format reference for both files and a reusable `CodeBlock` component with copy-to-clipboard.
- **Session Recaps** — Claude Code's `/recap` command writes `away_summary` entries into session JSONL files. Project Minder now surfaces these across all three session views: the recap text replaces the opening prompt as the primary session label in the project Sessions tab and the global Sessions browser (with an amber `recap` badge), and the session detail page shows the full recap history in the header — latest recap highlighted, older ones listed below. Sessions without recaps fall back to the existing `initialPrompt → lastPrompt → branch → "Untitled"` cascade.
- **Config Page** — New `/config` page (nav link: Config) with four sections: **Scan Roots** (add/remove/reorder multiple directories to scan, primary root labeled), **Scan Behavior** (configurable batch size 1–50), **Dashboard Defaults** (default sort and status filter stored in config), and **Hidden Projects** (unhide projects inline). Scanner, ManualStepsWatcher, and dev-server security validation all updated to support multiple roots. `PATCH /api/config` endpoint added for bulk settings updates.
- **Multiple scan roots** — `devRoots` array in `.minder.json` lets you monitor projects across different drives/locations. First entry is the primary root; backward-compat `devRoot` field is kept in sync automatically. Slug collision detection: first-root wins with console warning.
- **Token Usage Dashboard** — Dedicated `/usage` page with full cost observability inspired by [CodeBurn](https://github.com/AgentSeal/codeburn). Time-period filtering (Today/Week/Month/All), per-model and per-project cost breakdowns, 13-category activity classification, one-shot success rate detection, daily cost trend chart, shell command and MCP server usage tracking, project filter, and CSV/JSON export. LiteLLM pricing with hardcoded fallbacks. One-shot rate badges added to Sessions browser.
- **Add TODOs from the UI** — Append new items to any project's `TODO.md` without opening an editor. Per-project: inline "Add a new TODO..." form on the TODOs tab of the detail page. Cross-project: **Quick Add** button in the dashboard header (shortcut **Shift+T**) opens a modal with a multi-select project picker and one-idea-per-line textarea that fires parallel appends to every selected project. Creates `TODO.md` with a `# TODO` header if the file doesn't exist. Uses per-file mutex + atomic write to prevent clobbering on concurrent submissions. New `POST /api/todos/[slug]` route accepts `{text}` or `{items[]}`.
- **Hide projects UI** — Three-dot menu on project cards with "Hide project" action. Confirmation dialog before hiding. "(N hidden)" link in dashboard footer opens a manage modal to view and unhide projects. Uses `@radix-ui/react-dropdown-menu`.
- **Manual Steps Tracker** — Surfaces `MANUAL_STEPS.md` entries across all projects. Interactive checkboxes toggle steps on disk. Cross-project dashboard at `/manual-steps`. File watcher with real-time toast + OS notifications when Claude adds new steps.
- **Help system** — Contextual help panel (`?` shortcut) with docs for each page/tab. Help mapping for all routes.
- **Toast notification system** — Reusable toast provider with auto-dismiss, used by manual steps notifications.

- **Configurable DEV_ROOT** — Set `devRoot` in `.minder.json` to scan a directory other than `C:\dev`. Header displays the configured path.
- **Stats Dashboard** — Portfolio-wide analytics at `/stats`. Overview cards (projects, sessions, TODOs, costs), tech stack distribution (frameworks, ORMs, styling, services), project health (status, activity recency, TODO completion), and Claude Code usage (tokens, tools, models, errors). Inspired by [Sniffly](https://github.com/chiphuyen/sniffly).
- **Sessions Browser** — Browse all Claude Code sessions at `/sessions`. Search by prompt, project, or branch. Sort by recency, duration, or tokens. Active session indicators (green pulse). Click into session detail with timeline, tool usage, file operations, and subagent tracking. Inspired by [claude-code-karma](https://github.com/JayantDevkar/claude-code-karma).
- **Insights Browser** — Extracts and preserves Claude Code `★ Insight` blocks from conversation history into per-project `INSIGHTS.md` files (append-only, latest-first, deduplicated). Cross-project browser at `/insights` with search and project filter. Per-project "Insights" tab on detail pages. Bootstrap import script (`npx tsx scripts/import-insights.ts`) for one-time migration of existing insights. Violet lightbulb badge on dashboard cards.
- **Worktree Overlay** — TODOs, Manual Steps, and Insights from active Claude Code worktrees now appear in collapsible grouped sections on project detail pages (read-only). Dashboard card badges aggregate main + worktree item counts. ManualStepsWatcher discovers and watches worktree MANUAL_STEPS.md files for change notifications. Worktree directories discovered by `--claude-worktrees-` naming convention — no subprocess calls.

### Fixed
- **Insights not updating from new conversations** — `scanInsightsMd` only read the existing `INSIGHTS.md` file; new insights written during Claude Code sessions were never synced unless the one-time `scripts/import-insights.ts` script was run manually. Fixed by embedding `syncInsightsFromSessions` directly into `scanInsightsMd`: on each scan cycle it discovers matching JSONL files in `~/.claude/projects/`, uses `INSIGHTS.md` mtime as a watermark to skip unchanged files, extracts insight blocks via `parseInsightsFromJsonl`, and appends new ones with content-hash dedup. `appendInsights` moved into `insightsMd.ts`; `insightsWriter.ts` is now a thin re-export for backwards compatibility.
- **Sessions tab showing no results** — Fixed path matching bug in `ProjectSessions` where `decodeDirName()` was used to compare paths. The function replaces all hyphens with backslashes, so `C--dev-project-minder` became `C:\dev\project\minder` — never matching the real path. Now compares the raw encoded dir name (`projectName`) against `projectPath.replace(/[:\\/]/g, "-")`, which is always lossless.
- **Session list showing blank prompts** — Hook/system injection messages (e.g. `<user-prompt-submit-hook>`, `<command-name>`) were being captured as `initialPrompt` since they appear as `type: "text"` blocks in the first user message. Added `extractHumanText()` that skips any text block starting with `<`. Also tracks `lastPrompt` (updated on every qualifying user turn) so sessions that start with hook output still show the first real human message, with the last prompt shown as secondary context when it differs.
- **Manual Steps file corruption on rapid toggles** — Added per-file mutex to serialize read-modify-write cycles, atomic writes (write-to-temp-then-rename), and an empty-content guard that refuses to overwrite a file with blank content. Client-side: toggle requests are now queued (one in-flight at a time) with optimistic UI so checkboxes flip instantly on click. Prevents race condition where concurrent checkbox clicks or external editor access could blank the file.

### Changed
- **Sessions tab replaces Claude tab** — The "Claude" tab on project detail pages has been removed. The "Sessions" tab now serves as the single entry point for session data: aggregate stats, tool usage, model breakdown, and a full session list linking to individual session detail pages.
- **Upgraded to Next.js 16.2** — Turbopack is now the default bundler (removed `--turbopack` flag from dev script). Updated React to 19.2. Replaced `next lint` with direct `eslint .` command (`next lint` removed in v16).
- **Background git dirty status** — Dashboard cards now show real uncommitted change counts (amber `+N`). A background worker checks repos in batches of 3, and the dashboard polls for results. Detail pages still fetch on-demand for instant accuracy.
- Scanner now runs 8 modules (added `manualStepsMd`).
- Layout header includes "Manual Steps" nav link with pending count badge.
- Project detail page has a "Manual Steps" tab when applicable.
- Project cards show pending manual step count in amber.

### Removed
- Removed unused `@radix-ui/react-separator` dependency.
