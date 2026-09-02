## 2026-07-18 16:00 | wsl-integration | Bring the Ubuntu-26.04 WSL projects + sessions into the dashboard

- [x] Restart your running Minder server after the WSL PRs merge (#307/#308 + multi-home)
  The live service on :4100 runs the old build; the Settings sections and WSL scanning
  only exist after it picks up the new code (`pnpm build` + service restart, or tray restart).
- [x] Add the WSL scan root: Settings → Scan Roots → add `\\wsl.localhost\Ubuntu-26.04\home\josh\printing-press\library` → Save & Rescan
  Your real repos (`bamcli`, `micetrocli`, both with `.git`) live in `~/printing-press/library`,
  not `~/dev` (those are older git-less copies the scanner ignores), so type the path into the
  editor manually — the Detect WSL button only suggests `~/dev`-shaped roots. The distro must be
  Running during the first scan — Minder never starts it.
- [x] Add the WSL Claude home: Settings → Claude Homes → Detect WSL → "Add home + mapping" for `\\wsl.localhost\Ubuntu-26.04\home\josh\.claude` → Save & Rescan
  This also auto-adds the `/home/josh` ↔ `\\wsl.localhost\Ubuntu-26.04\home\josh` path mapping.
  That single mapping correlates the `-home-josh-printing-press-library-*` session dirs with the
  UNC projects automatically — no per-project mapping needed.
- [ ] Optional: allow git-over-UNC for WSL repos (branch/dirty status on their cards)
  `git config --global --add safe.directory '%(prefix)///wsl.localhost/Ubuntu-26.04/home/josh/printing-press/library/*'`
  Run from Windows (Git 2.55 supports the `/*` glob). Without it, WSL projects show no git
  metadata (Git's dubious-ownership protection) — everything else works.

---

## 2026-05-09 | wave12.1 | GitHub repo hardening — ruleset + permission changes

- [x] **Verify release workflow has `contents: write` permission** (v1.13.0 released via the workflow 2026-08-30)
  After pushing a `v*` tag, check the workflow run in Actions → Release.
  If it fails with a 403, go to GitHub → Settings → Actions → General → Workflow permissions
  and ensure "Read and write permissions" is selected.

- [ ] **Enable "Require code scanning results" after first CodeQL run**
  GitHub → Settings → Branches → `main-protection` → Code scanning → add CodeQL rule
  Do this only AFTER the CodeQL workflow has completed at least one successful run.

---

## 2026-05-05 | pr-review-responder | GitHub Action secrets + permissions setup

- [x] Add `ANTHROPIC_API_KEY` to repository secrets (present per `gh secret list`, 2026-05-06)
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
