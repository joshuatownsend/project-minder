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
