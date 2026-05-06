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
