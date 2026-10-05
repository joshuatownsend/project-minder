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

## 2026-07-19 14:30 | signing-updater | Accounts + keys for signed installers and auto-updates

> archived 2026-09-02 — PARKED 2026-09-02, not done — signed installers and auto-updates are deferred until/unless the app is used by others. The updater keypair + GitHub secret halves are complete; the Azure Artifact Signing, Apple Developer ID, App Store Connect key, and CI-secret items stay open and are recorded here so they do not clutter the active list. Reopen by moving this entry back.

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

## 2026-07-18 09:30 | tray-app | Tray app first-install + deferred acceptance checks (C2–C4)

> archived 2026-09-02 — closed 2026-09-02 — Windows install, autostart, and installer path tested by hand; macOS/Linux checks closed without a run, a new GitHub issue will be opened if problems surface there

- [x] One-time local dev setup: fetch the bundled Node runtime
  `node scripts/fetch-node-runtime.mjs` (creates `dist/node/`, checksum-verified against nodejs.org — required by `pnpm tray:dev` since C4 declares it a Tauri resource)
  The version is whatever `NODE_VERSION` in that script currently pins; it was 22.12.0 when this step was first run and is 22.13.0 as of #464.
  Done on this machine 2026-07-18; repeat once per fresh clone.
- [x] Windows login test for the autostart toggle (C2 acceptance)
  Enable "Start at login" in the tray menu, sign out and back in, confirm the tray relaunches and the checkbox is still checked. Toggle off afterward if undesired.
- [x] Exercise the installer workflow and verify the Windows installer end-to-end (C4 acceptance)
  Trigger `release-installers.yml` via a `v*` tag (or a `workflow_dispatch` dry-run first — artifacts land on the run, Releases untouched). Then: install the NSIS `.exe` → tray icon appears → server up → dashboard opens → Quit leaves no orphan `node.exe` (`tasklist | findstr node`). Expect a SmartScreen warning (unsigned).
- [x] First macOS/Linux installer run: check the bundled node exec bit (C4 known risk)
  The bundler may drop the execute mode on `node/bin/node`; if the sidecar fails to spawn on macOS/Linux, this is the first suspect.
- [x] Optional: verify a manual-steps toast end-to-end (C3 acceptance)
  Append an entry to any project's `MANUAL_STEPS.md` → expect an OS toast within ~90s (watcher ≤60s + tray poll ≤30s).

---

## 2026-05-05 | pr-review-responder | GitHub Action secrets + permissions setup

> archived 2026-09-02 — done 2026-09-02 — ANTHROPIC_API_KEY secret present; repo default workflow permission verified as write via the API; decision: comment-only on fork PRs is acceptable, no PAT (no fork PRs exist and a PAT would add a standing credential).

- [x] Add `ANTHROPIC_API_KEY` to repository secrets (present per `gh secret list`, 2026-05-06)
  Settings → Secrets and variables → Actions → New repository secret
  Name: `ANTHROPIC_API_KEY`, Value: your Anthropic API key
  See: https://docs.anthropic.com/en/api/getting-started
- [x] Verify `GITHUB_TOKEN` has write permissions for `contents` and `pull-requests`
  Settings → Actions → General → Workflow permissions → Read and write permissions
  (Required for the bot to push commits and post PR comments)
- [x] Confirm fork PR protection is acceptable
  The responder posts a comment on fork PRs instead of fixing — it cannot push to fork branches
  with GITHUB_TOKEN. If you need fork support, create a dedicated PAT and add it as a secret.

---

## 2026-05-10 14:00 | screenshot-to-code | Phase 6: build, key, register MCP server

> archived 2026-09-02 — done 2026-09-02 — decision: registered with the OpenAI provider (`claude mcp add screenshot-to-code -s user --env SCREENSHOT_PROVIDER=openai -- node C:\dev\project-minder\dist\mcp\screenshot-to-code\index.mjs`), using the OPENAI_API_KEY already on the machine; `claude mcp list` shows it Connected and an end-to-end stdio `tools/call` of `convert_screenshot_to_react` against the live OpenAI endpoint with `screenshots/01-config-initial.png` (68 KB) returned 4,239 chars of TSX, no markdown fences, in 36 s. The dashboard Playground reads the same env var, so a tray restart is needed only if OPENAI_API_KEY was set after the tray last started.

- [x] Build the bundled MCP server
  `npm run build:mcp-screenshot`
  Produces `dist/mcp/screenshot-to-code/index.mjs` (~9 KB ESM, shebang-prefixed). The build
  is `packages: "external"`, so Node resolves `@modelcontextprotocol/sdk`, `zod`, and
  every other dep from the project's `node_modules/` at spawn time — keep that tree intact.
- [x] Export an API key for the provider you want to use
  Default provider is **Gemini** (cheapest vision-capable model).
  PowerShell:
  `$env:GOOGLE_API_KEY = "AIza…"`     (or `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`)
  bash/zsh:
  `export GOOGLE_API_KEY=AIza…`
  Set this in your shell profile if you want it across new terminals.
  - Gemini keys: https://aistudio.google.com/app/apikey
  - OpenAI keys: https://platform.openai.com/api-keys
  - Anthropic keys: https://console.anthropic.com/settings/keys
- [x] Register the MCP server with Claude Code (so the `convert_screenshot_to_react` tool is callable)
  `claude mcp add screenshot-to-code -- node C:\dev\project-minder\dist\mcp\screenshot-to-code\index.mjs`
  To pin a non-default provider/model at spawn time:
  `claude mcp add screenshot-to-code --env SCREENSHOT_PROVIDER=anthropic --env SCREENSHOT_MODEL=claude-sonnet-4-5 -- node C:\dev\project-minder\dist\mcp\screenshot-to-code\index.mjs`
  Verify:
  `claude mcp list`     should show `screenshot-to-code` as `connected`
- [x] Restart the Project Minder dev server so the Next.js process inherits the new env var
  The `/config` → Playground tab uses the same env var the MCP server does. If the dashboard
  shows `412 API_KEY_MISSING`, the dev server was started before the env var was exported —
  stop it and re-run `npm run dev`.
- [x] Smoke-test the tool from Claude Code
  In Claude Code: ask "Use the screenshot-to-code MCP tool on this image:" and attach a UI
  screenshot. The tool should return TSX with no markdown fences.

---

## 2026-09-29 23:10 | slow-boot | Get the #584/#585/#586 fixes into the running tray and verify them

> archived 2026-10-04 — all four checks observed; Check 1 closed by the v1.16.4 restart (tray read "slow to respond" ~1 min, then "running").

- [x] Install the v1.16.2 tray build (cut 2026-09-30; both fixes are in it: #587 and #589)
  The fixes live in two places, and the running tray on :4100 (v1.16.1) has none of them. Tray binary (Rust): 10 s health-probe timeout and the "slow to respond" label (#587). Packaged server (TS): the efficiency-grade sweep deferred behind the initial reconcile (#587), the ingest worker's start-handshake budget 60 s → 5 min, and durable failure logging (#589).
  Pushing the `v1.16.2` tag fires `release.yml` (creates the GitHub Release) and `release-installers.yml` (four platform bundles + `latest.json` for the updater, ~15-25 min). Install once the installers run is green, via the in-app updater or `Project.Minder.Tray_1.16.2_x64-setup.exe` from the release.
  For future releases: do **not** run `gh release create` — it races the workflow, and whichever loses fails (that is what turned the v1.9.0/v1.9.1 `Release` runs red). Let the tag create the Release, then swap in curated notes with `gh release edit vX.Y.Z --notes-file <file> --latest`.
- [x] Reboot with the new build installed
  The four checks below were run after the 12:23 EDT reboot on 2026-09-30. (#586 was auto-closed by GitHub when #589 merged, before they ran; it was re-verified by them and the evidence is commented on the issue.)
- [x] Check 1 — tray: it never reads "not responding" while the server is up and busy
  Either "slow to respond" (the health probe timed out but the port still accepts connections) or "running" (the probe answered within the 10 s budget) is a pass — with the boot-load fixes the server may answer in time and never show the slow state. "not responding" is the failure.
  Observed (user): "running" about five minutes after the 12:23 boot, while the reconcile was still running in the worker (it finished 12:47). NOT observed: the first ~2.5 min (main-thread DB probe 12:23:41-12:25:07, scan to 12:26:01). Tick when seen, or waive.
  Result 2026-10-04 (v1.16.4, graceful restart; user report): the tray read "slow to respond" for about a minute after launch, then "running". Server log: port open +2 s, `/api/health` first answered 200 at ~+68 s (the project scan blocks it), so "slow to respond" was the correct label and the early window is now observed. Not reported: whether the first few seconds, before the port opened, read "not responding".
- [x] Check 2 — `http://localhost:4100/api/health`: `ingest.mode` is `"worker"` with `crashesLastHour: 0`
  It was `"in-process"` on every boot since ~09-26.
  Result 2026-09-30: `"worker"`, `crashesLastHour: 0`, version 1.16.2 (tray exe 1.16.2 too).
- [x] Check 3 — `~/.minder/logs/minder.log`: a `watcher armed after N ms` line and no failure lines, from THIS boot only
  The file is append-only until it rotates, so read only the lines after the last `starting service-mode boot sequence…` entry; an older boot's failure line proves nothing about this one. Expect `watcher armed after N ms` with a `phaseMs` breakdown showing where startup time went (`initDb` was ~21 s warm on the 2.5 GB index), and **no** `start handshake failed` / `worker failed before ready` lines. If one is present it names the reason, elapsed time and timeout.
  Result 2026-09-30: no failure lines on either 1.16.2 boot. `watcher armed after` 106.7 s (09:18 graceful restart; worker `initDb` 76.7 s) and 64.5 s (12:23 reboot; `initDb` 34.4 s) — both over the old 60 s budget, which would have fallen back (#586, #588).
- [x] Check 4 — `~/.minder/index.db` → `indexer_runs`: this boot has ONE `reconcile` row
  Every boot since 09-26 produced an aborted/orphaned ~60 s run followed by a second one. Also compare the row's duration with 689 s from 2026-09-29; if it did not shorten, the grade sweep was not the main contributor.
  Result 2026-09-30: ONE `reconcile` row per boot (no aborted/orphaned pair). Duration did NOT shorten: 1261 s vs the 689 s baseline (849 s at 09:20) — the grade sweep was not the main cost; tracked in #595.
- [x] Record the outcome of Checks 1-4, then close out
  All four pass → close #586 and archive this entry. Check 2 still shows `"in-process"` → the log line from Check 3 is the diagnosis; the known follow-ups are #588 (the duplicate `PRAGMA quick_check` that spends ~21 s of the handshake budget on every start) and #585 (the usage cache is smaller than the corpus, so later whole-history sweeps still re-parse most of it). Either way this item is done once the result is written down.
  Unrelated: #590 is a flaky Windows CI test (10 s hook timeout in `subagentBillingBoundary.test.ts` and other DB-backed tests), not a product problem.

  Recorded 2026-09-30: #586 verified fixed (closed); #588 updated with the worker-`initDb` numbers; slow reconcile filed as #595. The entry stayed open only for Check 1's unobserved early window (observed 2026-10-04, see Check 1).
---

## 2026-10-01 01:19 | slow-boot | Confirm the native recursive watch fixes the slow initial reconcile (#595)

> archived 2026-10-04 — all three checks observed on v1.16.3/v1.16.4 (reconcile 10 s, native watcher, live events ~265 ms).

- [x] After the release containing this change is installed and the tray restarted (or the machine rebooted), check `http://localhost:4100/api/health`
  `ingest.watcherMode` should be `"native"` immediately (it used to sit on `"arming"` for minutes).
  Result 2026-10-03 (16:42 EDT reboot, v1.16.3): `ingest.mode` `"worker"`, `watcherMode` `"native"`, `crashesLastHour` 0, `initialReconcileMs` 10307.
- [x] Check `~/.minder/logs/minder.log` for the `reconcile finished in N ms` line
  Expect tens of seconds, not the 689 -> 849 -> 1261 s seen before. Lab measurement on the real corpus: 24.9 s total, 20.4 s of it in `prune` (a separate open question - the next thing to look at).
  Result 2026-10-03: `reconcile finished in 10302 ms` (`prune` 90 ms, so the 20 s was chokidar contention). `watcher armed after 31403 ms`. The remaining ~3.3 min of slow boot is `PRAGMA quick_check` (main probe 95 s + worker initDb 31 s) because the clean-shutdown marker is stale (#588).
- [x] Edit a transcript (any Claude Code session) and confirm the dashboard sees it without waiting for the 30 s sweep
  Not covered by the lab run: it only measured the reconcile, not live event delivery on the real tree.
  Result 2026-10-04 (v1.16.4, real tree): used this very session's transcript as the event source and compared the file with `sessions.byte_offset`/`turn_count` in `index.db`, polling every 250 ms for ~80 s (57 file growths). Start gap 0 B; the index reached each write after a median of 265 ms (n=18; p90 2.4 s, max 2.9 s during back-to-back bursts) against a 30 s sweep, and `/api/health` `ingest.eventsHandled` went 0 (at arm time, so no replay of existing files) -> 27 -> 43 -> 70. Measured the INDEX, not a browser tab: the dashboard reads the index, but the UI refresh itself was not timed.

---

## 2026-10-04 13:45 | slow-boot | Confirm access-time events no longer inflate ingest.eventsHandled (#604, PR #605)
> archived 2026-10-05 — both checks done on v1.16.5

- [x] After the release containing PR #605 is installed and the tray restarted, wait ~5 minutes and read `http://localhost:4100/api/health` -> `ingest.eventsHandled`
  It should stay in the single digits until a transcript is actually written (each real write adds a few). Before the fix it was 8,666 at uptime 202 s with one transcript written, and 12,706 at 533 s after the 2026-10-03 reboot.
  To make sure the history-wide read has happened first, let the dashboard run a few minutes (the post-boot grade/usage sweeps are what touch every transcript). `fsutil behavior query disablelastaccess` should still say last-access updates are ENABLED on this machine, otherwise the test proves nothing.
  Result 2026-10-05 (v1.16.5): last-access updates ENABLED (`DisableLastAccess = 2`). 7 min after the tray restart, with the post-boot grade/usage sweeps enqueued at 15:20:08Z and a ~6.4 s initial reconcile, `eventsHandled` was **0** (was 8,666 at 202 s / 12,706 at 533 s). `watcherMode: native`, `crashesLastHour: 0`.
- [x] Optional: confirm a real write is still seen live
  Re-run the lag probe (transcript size vs `sessions.byte_offset`) or just watch `eventsHandled` rise while a Claude Code session is active; the index should still lag a write by well under the 30 s sweep (v1.16.4 measured a median of 265 ms).
  Result 2026-10-05: this session's own transcript writes moved `eventsHandled` 0 -> 12 within ~15 s, then it held at 12 across three further reads with no writes: real writes are counted, reads are not.

---
