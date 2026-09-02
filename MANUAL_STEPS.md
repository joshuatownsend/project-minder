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

## 2026-07-18 09:30 | tray-app | Tray app first-install + deferred acceptance checks (C2–C4)

- [x] One-time local dev setup: fetch the bundled Node runtime
  `node scripts/fetch-node-runtime.mjs` (creates `dist/node/`, checksum-verified against nodejs.org — required by `pnpm tray:dev` since C4 declares it a Tauri resource)
  The version is whatever `NODE_VERSION` in that script currently pins; it was 22.12.0 when this step was first run and is 22.13.0 as of #464.
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
