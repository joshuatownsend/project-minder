## 2026-07-19 14:30 | signing-updater | Accounts + keys for signed installers and auto-updates

Plan: `docs/superpowers/plans/2026-07-19-signing-updater-release.md`.
Start the two account items FIRST — Azure validation can take up to 20 business days and is
the critical path. The updater work (free) can proceed in parallel while you wait.

- [ ] Sign up for **Azure Artifact Signing** and complete individual identity validation
  ~$9.99/month. Renamed from "Trusted Signing" in Jan 2026.
  Individuals are **US + Canada only** — you qualify (US).
  Validation needs: government photo ID (passport / driver's license / state ID) **and** a
  proof-of-address document (utility bill or bank statement) dated within ~3 months.
  Takes 1–20 business days. **Verify at signup that the old "3 years of business history"
  requirement is genuinely gone** — the live docs describe ID-only validation, but the exact
  date that changed could not be confirmed during research.
  See: https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
  Do NOT buy an EV certificate — since 2024 it no longer grants instant SmartScreen
  reputation and costs ~4× more for no benefit. (Tauri's own docs are stale on this.)
- [ ] Create an **Apple Developer ID Application** certificate (not App Store)
  Uses your existing Apple Developer Program membership ($99/yr).
  Export as `.p12`, then base64-encode it for CI.
- [ ] Create an **App Store Connect API key** for notarization
  Preferred over Apple ID + app-specific password, which ties builds to one person's
  account permissions. Download the `.p8` — Apple only lets you download it once.
  You'll need the Issuer ID and Key ID alongside it.
- [ ] Add the GitHub Actions secrets once both accounts are validated
  Windows (OIDC preferred): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
  and the `Trusted Signing Certificate Profile Signer` role assignment.
  macOS: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
  `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`.
- [x] Generate the updater signing keypair
  Done 2026-07-19. Generated with an empty password at `C:\Users\joshu\.tauri\minder.key`
  (public half at `minder.key.pub`). The public key is committed in
  `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.
- [x] **Back up `~/.tauri/minder.key`** — confirmed backed up 2026-07-19.
  **This key is unrecoverable and permanent.** If it is lost, every already-installed user is
  stranded forever: their binary only trusts that one public key, so you can never ship them
  another update. It has no password, so the file itself is the entire secret — treat it like
  a private SSH key. The GitHub secret is **not** a backup: secrets are write-only and can
  never be read back out.
- [x] Add `TAURI_SIGNING_PRIVATE_KEY` as a GitHub Actions secret
  Done 2026-07-19 (verified via `gh secret list`). No password secret is needed — the key was
  generated without one, and `release-installers.yml` passes an empty
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
  Note for **local** signed builds: Tauri does not read `.env` files for this — it must be a
  real environment variable (`$env:TAURI_SIGNING_PRIVATE_KEY` in PowerShell).

---

## 2026-07-18 16:00 | wsl-integration | Bring the Ubuntu-26.04 WSL projects + sessions into the dashboard

- [ ] Restart your running Minder server after the WSL PRs merge (#307/#308 + multi-home)
  The live service on :4100 runs the old build; the Settings sections and WSL scanning
  only exist after it picks up the new code (`pnpm build` + service restart, or tray restart).
- [ ] Add the WSL scan root: Settings → Scan Roots → add `\\wsl.localhost\Ubuntu-26.04\home\josh\printing-press\library` → Save & Rescan
  Your real repos (`bamcli`, `micetrocli`, both with `.git`) live in `~/printing-press/library`,
  not `~/dev` (those are older git-less copies the scanner ignores), so type the path into the
  editor manually — the Detect WSL button only suggests `~/dev`-shaped roots. The distro must be
  Running during the first scan — Minder never starts it.
- [ ] Add the WSL Claude home: Settings → Claude Homes → Detect WSL → "Add home + mapping" for `\\wsl.localhost\Ubuntu-26.04\home\josh\.claude` → Save & Rescan
  This also auto-adds the `/home/josh` ↔ `\\wsl.localhost\Ubuntu-26.04\home\josh` path mapping.
  That single mapping correlates the `-home-josh-printing-press-library-*` session dirs with the
  UNC projects automatically — no per-project mapping needed.
- [ ] Optional: allow git-over-UNC for WSL repos (branch/dirty status on their cards)
  `git config --global --add safe.directory '%(prefix)///wsl.localhost/Ubuntu-26.04/home/josh/printing-press/library/*'`
  Run from Windows (Git 2.55 supports the `/*` glob). Without it, WSL projects show no git
  metadata (Git's dubious-ownership protection) — everything else works.

---

## 2026-07-17 08:00 | service-mode | Register Minder's autostart service (task A3, one time per machine)

- [ ] Build the server, then register the logon autostart task
  `pnpm build && pnpm package:standalone` (recommended — self-contained `dist/minder-server`)
  then `pnpm service:install`
  Windows may show a UAC/consent prompt for Task Scheduler — accept it. This registers a
  **Scheduled Task with a logon trigger** (not a Windows Service — services default to
  LocalSystem, which can't see `~/.claude`, `C:\dev`, or `~/.minder`). Verify with
  `pnpm service:status` or `schtasks /query /tn MinderDashboard`.
- [ ] Know the two related commands and their limits
  `pnpm service:uninstall` removes the registration only — it does **not** stop an already-running
  server. If one is running and you want it stopped too, run `pnpm service:stop` yourself first.
  `pnpm service:stop` on Windows is a hard-stop (kills whatever is listening on port 4100) — Task
  Scheduler loses track of the process almost immediately after logon, so there is no graceful-signal
  path yet. Confirm nothing else you care about is bound to port 4100 before running it. A2's boot
  reconcile + SQLite WAL recovery make an unclean stop safe for Minder's own data.
- [ ] macOS (`com.minder.dashboard.plist`) and Linux (`minder.service`, systemd `--user`) templates
  ship in this PR but are reviewed-only — no CI/hands-on verification on those platforms yet.
- [ ] macOS/Linux only: PATH is captured from the installing shell and frozen into the plist/unit
  at install time (launchd/systemd `--user` services don't inherit your login shell's PATH, so
  without this `git`/`gh`/`claude` would silently fail to resolve). If you later install Homebrew,
  switch your active Node via nvm, or otherwise change PATH, re-run `pnpm service:install` to pick
  up the new value — the service won't see PATH changes on its own. Not applicable on Windows (the
  Scheduled Task already tracks the live registry PATH on every run).

---

## 2026-05-09 | wave12.1 | GitHub repo hardening — ruleset + permission changes

- [ ] **Enable "Require signed commits" on the `main` branch ruleset**
  GitHub → Settings → Branches → `main-protection` → enable "Require signed commits"
  Prerequisite: at least one signed commit must already exist on the branch.
  See: https://docs.github.com/en/authentication/managing-commit-signature-verification

- [ ] **Verify release workflow has `contents: write` permission**
  After pushing a `v*` tag, check the workflow run in Actions → Release.
  If it fails with a 403, go to GitHub → Settings → Actions → General → Workflow permissions
  and ensure "Read and write permissions" is selected.

- [ ] **Enable "Require code scanning results" after first CodeQL run**
  GitHub → Settings → Branches → `main-protection` → Code scanning → add CodeQL rule
  Do this only AFTER the CodeQL workflow has completed at least one successful run.

---

## 2026-05-07 | wave8.1b | Phase 0 — Capture real OTEL data (reinstall required — wizard was broken)

**Context**: The wizard was missing OTEL_METRICS_EXPORTER=otlp and OTEL_LOGS_EXPORTER=otlp.
Without those the SDK exports nothing. If you already installed via the wizard, click Remove first,
then Install again to pick up the fix.

- [x] Root cause identified: wizard missing OTEL_METRICS_EXPORTER and OTEL_LOGS_EXPORTER (fixed in code)
- [ ] With Project Minder running (`npm run dev`):
  1. Open http://localhost:4100/settings (or Settings → Integrations → OTEL)
  2. If OTEL shows as **Installed**, click **Remove** first
  3. Click **Install** — this now writes all 6 required env vars:
     CLAUDE_CODE_ENABLE_TELEMETRY=1, OTEL_METRICS_EXPORTER=otlp, OTEL_LOGS_EXPORTER=otlp,
     OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL=http/json, OTEL_LOG_TOOL_DETAILS=1
- [ ] Verify ~/.claude/settings.json contains all 6 vars (especially the two new ones):
  `node -e "const s=require('fs').readFileSync(require('os').homedir()+'/.claude/settings.json','utf8'); console.log(JSON.stringify(JSON.parse(s).env,null,2))"`
- [ ] **Fully restart Claude Code** — close all windows, reopen from Start menu / taskbar
- [ ] Confirm Project Minder is running on port 4100 (OTEL needs to reach localhost:4100)
- [ ] Run a Claude Code session in ANY project that exercises:
  - At least 5 different tools (Read, Edit, Write, Bash, mcp__*)
  - At least 3 Edit/Write proposals with mixed accept/reject decisions
  - Long enough for one full API call cycle (>1 minute total)
- [ ] Run the Phase 0 probe script:
  `node scripts/probe-otel.mjs`
  Confirm the "Request log" section shows ≥1 request (proves endpoint is being hit)
  Confirm it reports ≥1 row for tool_result, tool_decision, api_request, and ≥1 metric data point
- [ ] Share the probe output so otelQueries.ts can be written against the verified attribute schema

---

## 2026-05-05 | pr-review-responder | GitHub Action secrets + permissions setup

- [ ] Add `ANTHROPIC_API_KEY` to repository secrets
  Settings → Secrets and variables → Actions → New repository secret
  Name: `ANTHROPIC_API_KEY`, Value: your Anthropic API key
  See: https://docs.anthropic.com/en/api/getting-started
- [ ] Verify `GITHUB_TOKEN` has write permissions for `contents` and `pull-requests`
  Settings → Actions → General → Workflow permissions → Read and write permissions
  (Required for the bot to push commits and post PR comments)
- [ ] Confirm fork PR protection is acceptable
  The responder posts a comment on fork PRs instead of fixing — it cannot push to fork branches
  with GITHUB_TOKEN. If you need fork support, create a dedicated PAT and add it as a secret.

---

## 2026-04-16 | repo-hardening | Enable branch protection + CI for public release

- [ ] Apply `main-protection` ruleset in GitHub UI
  Settings → Rules → Rulesets → New branch ruleset
  Target: `refs/heads/main`, Enforcement: Active
  Bypass list: add `joshuatownsend` with role `bypass` set to `always`
  Rules: Restrict deletions ON, Block force pushes ON, Require linear history ON,
         Require PR before merging ON (0 required approvals), Dismiss stale approvals ON,
         Require conversation resolution ON
- [ ] Set repo merge settings to squash-only
  Settings → General → Pull Requests
  Disable: Allow merge commits, Allow rebase merging
  Enable: Allow squash merging (default message: "Pull request title and description")
  Enable: Automatically delete head branches
  Enable: Always suggest updating pull request branches
- [ ] Turn on Dependabot alerts + security updates
  Settings → Code security and analysis → Dependabot
- [ ] Turn on Secret scanning + Push protection
  Settings → Code security and analysis → Secret scanning
- [ ] Enable Private vulnerability reporting
  Settings → Code security and analysis → Private vulnerability reporting
- [ ] Commit `.github/workflows/ci.yml` on a PR, confirm first CI run passes
  The job is named `verify` — confirm it appears in the Checks tab
- [ ] After first successful CI run, re-open the `main-protection` ruleset and add required status check
  Require status checks to pass: ON
  Require branches to be up to date: ON
  Required check: `verify`
- [ ] Run verification: try `git push --force-with-lease origin main` — should be rejected
- [ ] Run verification: try pushing directly to main — should be rejected (PR required)
- [ ] Run verification: open a PR that breaks a test, confirm CI blocks merge

---

## 2026-04-27 | skill-provenance | GITHUB_TOKEN for update-check rate limits

- [ ] Set `GITHUB_TOKEN` environment variable on this machine for GitHub API rate-limit headroom
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

## 2026-05-10 14:00 | screenshot-to-code | Phase 6: build, key, register MCP server

- [ ] Build the bundled MCP server
  `npm run build:mcp-screenshot`
  Produces `dist/mcp/screenshot-to-code/index.mjs` (~9 KB ESM, shebang-prefixed). The build
  is `packages: "external"`, so Node resolves `@modelcontextprotocol/sdk`, `zod`, and
  every other dep from the project's `node_modules/` at spawn time — keep that tree intact.
- [ ] Export an API key for the provider you want to use
  Default provider is **Gemini** (cheapest vision-capable model).
  PowerShell:
  `$env:GOOGLE_API_KEY = "AIza…"`     (or `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`)
  bash/zsh:
  `export GOOGLE_API_KEY=AIza…`
  Set this in your shell profile if you want it across new terminals.
  - Gemini keys: https://aistudio.google.com/app/apikey
  - OpenAI keys: https://platform.openai.com/api-keys
  - Anthropic keys: https://console.anthropic.com/settings/keys
- [ ] Register the MCP server with Claude Code (so the `convert_screenshot_to_react` tool is callable)
  `claude mcp add screenshot-to-code -- node C:\dev\project-minder\dist\mcp\screenshot-to-code\index.mjs`
  To pin a non-default provider/model at spawn time:
  `claude mcp add screenshot-to-code --env SCREENSHOT_PROVIDER=anthropic --env SCREENSHOT_MODEL=claude-sonnet-4-5 -- node C:\dev\project-minder\dist\mcp\screenshot-to-code\index.mjs`
  Verify:
  `claude mcp list`     should show `screenshot-to-code` as `connected`
- [ ] Restart the Project Minder dev server so the Next.js process inherits the new env var
  The `/config` → Playground tab uses the same env var the MCP server does. If the dashboard
  shows `412 API_KEY_MISSING`, the dev server was started before the env var was exported —
  stop it and re-run `npm run dev`.
- [ ] Smoke-test the tool from Claude Code
  In Claude Code: ask "Use the screenshot-to-code MCP tool on this image:" and attach a UI
  screenshot. The tool should return TSX with no markdown fences.

---

## 2026-07-18 09:30 | tray-app | Tray app first-install + deferred acceptance checks (C2–C4)

- [x] One-time local dev setup: fetch the bundled Node runtime
  `node scripts/fetch-node-runtime.mjs` (creates `dist/node/`, checksum-verified Node 22.12.0 — required by `pnpm tray:dev` since C4 declares it a Tauri resource)
  Done on this machine 2026-07-18; repeat once per fresh clone.
- [ ] Windows login test for the autostart toggle (C2 acceptance)
  Enable "Start at login" in the tray menu, sign out and back in, confirm the tray relaunches and the checkbox is still checked. Toggle off afterward if undesired.
- [ ] Exercise the installer workflow and verify the Windows installer end-to-end (C4 acceptance)
  Trigger `release-installers.yml` via a `v*` tag (or a `workflow_dispatch` dry-run first — artifacts land on the run, Releases untouched). Then: install the NSIS `.exe` → tray icon appears → server up → dashboard opens → Quit leaves no orphan `node.exe` (`tasklist | findstr node`). Expect a SmartScreen warning (unsigned).
- [ ] First macOS/Linux installer run: check the bundled node exec bit (C4 known risk)
  The bundler may drop the execute mode on `node/bin/node`; if the sidecar fails to spawn on macOS/Linux, this is the first suspect.
- [ ] Optional: verify a manual-steps toast end-to-end (C3 acceptance)
  Append an entry to any project's `MANUAL_STEPS.md` → expect an OS toast within ~90s (watcher ≤60s + tray poll ≤30s).

---
