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
