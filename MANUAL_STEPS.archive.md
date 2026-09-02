# Manual Steps — Archive

<!-- Fully-completed MANUAL_STEPS entries, archived from MANUAL_STEPS.md. Seeded 2026-06-26. -->

## 2026-03-17 14:32 | notifications | Toast & OS Notification Setup

- [x] Grant browser notification permission when prompted
  Click "Allow" on the browser permission dialog
- [x] Verify notification sound plays on new entry detection
  Open DevTools console and check for audio errors
- [x] Add notification.wav to public/sounds/
  Already done during implementation

---

## 2026-03-17 15:10 | testing | Manual Steps Feature Verification

- [x] Visit /manual-steps page and verify cross-project view
  See: http://localhost:4100/manual-steps
- [x] Click a project card with manual steps, check the new tab
- [x] Toggle a checkbox and verify MANUAL_STEPS.md updates on disk
- [x] Test real-time detection by appending a new entry to any MANUAL_STEPS.md

---

## 2026-04-16 | github-pages | Enable GitHub Pages from gh-pages branch

- [x] Go to https://github.com/joshuatownsend/project-minder/settings/pages
- [x] Under "Build and deployment" → Source, select "Deploy from a branch"
- [x] Branch: gh-pages, Folder: / (root)
- [x] Click Save
  Site will be live at https://joshuatownsend.github.io/project-minder within ~1 minute

---

## 2026-08-05 19:30 | index-downgrade | Don't restart the v1.7.0 tray until a new build is packaged

> archived 2026-09-01 — the installed tray is now 1.13.0, which carries the downgrade guard; index schema 30, reconcile complete, no downgrade since

The installed tray (`%LOCALAPPDATA%\Project Minder Tray`, packaged 2026-08-03) ships
`DERIVED_VERSION = 12`. On 2026-08-05 it reverted the whole index from v14 to v12,
discarding 22,682 `turns.effort` values and 1,141 `task_outcome` stamps roughly 30 minutes
after a 45-minute re-parse completed, reporting `errors: 0` throughout.

The guard that prevents this (`fix(db): never let an older build downgrade a newer index`,
`d6dc4bf`) is in the repo, **not in that packaged build** — a build can only refuse a
downgrade if the guard is in the build doing the writing. So the installed tray will do it
again if it starts.

- [x] Leave the tray stopped until a build carrying `d6dc4bf` is packaged and installed
  It was stopped at 2026-08-05 ~18:10 (tray PID 54768 + node sidecar 19124, both confirmed down).
  Restarting the current v1.7.0 build re-runs the downgrade on the freshly re-indexed DB.
- [x] Package and install a tray build from `main` once this branch merges
  `pnpm package:standalone` then `pnpm tray:build` (see `docs/help/tray-app.md`)
  Verify before trusting it: `node -e "..."` on `~/.minder/index.db` should show
  `derived_version = 14` holding steady after the tray has been running a few minutes.
- [x] Confirm the guard fires rather than silently doing nothing
  A build older than the index now logs `[ingest] N session(s) left untouched: their rows
  were derived by a newer build than this one`. Seeing that line is the success case.

---

## 2026-07-17 08:00 | service-mode | Register Minder's autostart service (task A3, one time per machine)

> archived 2026-09-01 — decision 2026-09-01: no logon Scheduled Task; the tray app is the permanent launcher

- [x] Build the server, then register the logon autostart task
  `pnpm build && pnpm package:standalone` (recommended — self-contained `dist/minder-server`)
  then `pnpm service:install`
  Windows may show a UAC/consent prompt for Task Scheduler — accept it. This registers a
  **Scheduled Task with a logon trigger** (not a Windows Service — services default to
  LocalSystem, which can't see `~/.claude`, `C:\dev`, or `~/.minder`). Verify with
  `pnpm service:status` or `schtasks /query /tn MinderDashboard`.
- [x] Know the two related commands and their limits
  `pnpm service:uninstall` removes the registration only — it does **not** stop an already-running
  server. If one is running and you want it stopped too, run `pnpm service:stop` yourself first.
  `pnpm service:stop` on Windows is a hard-stop (kills whatever is listening on port 4100) — Task
  Scheduler loses track of the process almost immediately after logon, so there is no graceful-signal
  path yet. Confirm nothing else you care about is bound to port 4100 before running it. A2's boot
  reconcile + SQLite WAL recovery make an unclean stop safe for Minder's own data.
- [x] macOS (`com.minder.dashboard.plist`) and Linux (`minder.service`, systemd `--user`) templates
  ship in this PR but are reviewed-only — no CI/hands-on verification on those platforms yet.
- [x] macOS/Linux only: PATH is captured from the installing shell and frozen into the plist/unit
  at install time (launchd/systemd `--user` services don't inherit your login shell's PATH, so
  without this `git`/`gh`/`claude` would silently fail to resolve). If you later install Homebrew,
  switch your active Node via nvm, or otherwise change PATH, re-run `pnpm service:install` to pick
  up the new value — the service won't see PATH changes on its own. Not applicable on Windows (the
  Scheduled Task already tracks the live registry PATH on every run).

---

## 2026-05-07 | wave8.1b | Phase 0 — Capture real OTEL data (reinstall required — wizard was broken)

> archived 2026-09-01 — verified done: all 6 OTEL env vars present in ~/.claude/settings.json and the index holds 20k+ otel_events / 9.5k otel_metrics

**Context**: The wizard was missing OTEL_METRICS_EXPORTER=otlp and OTEL_LOGS_EXPORTER=otlp.
Without those the SDK exports nothing. If you already installed via the wizard, click Remove first,
then Install again to pick up the fix.

- [x] Root cause identified: wizard missing OTEL_METRICS_EXPORTER and OTEL_LOGS_EXPORTER (fixed in code)
- [x] With Project Minder running (`npm run dev`):
  1. Open http://localhost:4100/settings (or Settings → Integrations → OTEL)
  2. If OTEL shows as **Installed**, click **Remove** first
  3. Click **Install** — this now writes all 6 required env vars:
     CLAUDE_CODE_ENABLE_TELEMETRY=1, OTEL_METRICS_EXPORTER=otlp, OTEL_LOGS_EXPORTER=otlp,
     OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL=http/json, OTEL_LOG_TOOL_DETAILS=1
- [x] Verify ~/.claude/settings.json contains all 6 vars (especially the two new ones):
  `node -e "const s=require('fs').readFileSync(require('os').homedir()+'/.claude/settings.json','utf8'); console.log(JSON.stringify(JSON.parse(s).env,null,2))"`
- [x] **Fully restart Claude Code** — close all windows, reopen from Start menu / taskbar
- [x] Confirm Project Minder is running on port 4100 (OTEL needs to reach localhost:4100)
- [x] Run a Claude Code session in ANY project that exercises:
  - At least 5 different tools (Read, Edit, Write, Bash, mcp__*)
  - At least 3 Edit/Write proposals with mixed accept/reject decisions
  - Long enough for one full API call cycle (>1 minute total)
- [x] Run the Phase 0 probe script:
  `node scripts/probe-otel.mjs`
  Confirm the "Request log" section shows ≥1 request (proves endpoint is being hit)
  Confirm it reports ≥1 row for tool_result, tool_decision, api_request, and ≥1 metric data point
- [x] Share the probe output so otelQueries.ts can be written against the verified attribute schema

---

## 2026-04-16 | repo-hardening | Enable branch protection + CI for public release

> archived 2026-09-01 — verified done via gh api: main-protection ruleset active (deletion/force-push/linear-history/PR/verify status check), squash-only, auto-delete branches, Dependabot + secret scanning + push protection enabled

- [x] Apply `main-protection` ruleset in GitHub UI
  Settings → Rules → Rulesets → New branch ruleset
  Target: `refs/heads/main`, Enforcement: Active
  Bypass list: add `joshuatownsend` with role `bypass` set to `always`
  Rules: Restrict deletions ON, Block force pushes ON, Require linear history ON,
         Require PR before merging ON (0 required approvals), Dismiss stale approvals ON,
         Require conversation resolution ON
- [x] Set repo merge settings to squash-only
  Settings → General → Pull Requests
  Disable: Allow merge commits, Allow rebase merging
  Enable: Allow squash merging (default message: "Pull request title and description")
  Enable: Automatically delete head branches
  Enable: Always suggest updating pull request branches
- [x] Turn on Dependabot alerts + security updates
  Settings → Code security and analysis → Dependabot
- [x] Turn on Secret scanning + Push protection
  Settings → Code security and analysis → Secret scanning
- [x] Enable Private vulnerability reporting
  Settings → Code security and analysis → Private vulnerability reporting
- [x] Commit `.github/workflows/ci.yml` on a PR, confirm first CI run passes
  The job is named `verify` — confirm it appears in the Checks tab
- [x] After first successful CI run, re-open the `main-protection` ruleset and add required status check
  Require status checks to pass: ON
  Require branches to be up to date: ON
  Required check: `verify`
- [x] Run verification: try `git push --force-with-lease origin main` — should be rejected
- [x] Run verification: try pushing directly to main — should be rejected (PR required)
- [x] Run verification: open a PR that breaks a test, confirm CI blocks merge

---

## 2026-04-27 | skill-provenance | GITHUB_TOKEN for update-check rate limits

> archived 2026-09-01 — verified done: GITHUB_TOKEN is set in the shell environment

- [x] Set `GITHUB_TOKEN` environment variable on this machine for GitHub API rate-limit headroom
  The update-check cache in `/api/catalog-updates` calls the GitHub API to compare lockfile skill
  hashes against upstream tree SHAs. Unauthenticated requests are capped at 60/hour per IP.
  With a 24-hour cache TTL this is sufficient for most cases, but adding a token raises the
  limit to 5,000/hour and avoids any risk of rate-limit errors.
  Steps:
  1. Create a GitHub personal access token (classic) at https://github.com/settings/tokens
     with no scopes — only public repo access is needed.
  2. Set in your shell profile:
     `$env:GITHUB_TOKEN = "ghp_xxxxxxxxxxxx"` (PowerShell profile)
     or `export GITHUB_TOKEN=ghp_xxxxxxxxxxxx` (bash/zsh .profile)
  3. Restart the Project Minder dev server so the server process inherits the env var.

---

## 2026-05-09 | wave12.1 | Dropped item — Require signed commits on main

> archived 2026-09-01 — dropped by decision: the rule would reject Dependabot/Copilot bot commits and squash merges; not worth the friction for a solo repo.

- [x] **Enable "Require signed commits" on the `main` branch ruleset**
  GitHub → Settings → Branches → `main-protection` → enable "Require signed commits"
  Prerequisite: at least one signed commit must already exist on the branch.
  See: https://docs.github.com/en/authentication/managing-commit-signature-verification

---
