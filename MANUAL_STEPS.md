## 2026-09-29 23:10 | tray-slow-boot | Get the #584/#585 fixes into the running tray

- [ ] After the PR for `fix/slow-boot-tray-and-grade-sweep-584-585` merges, cut a release and install the new tray build
  The fixes live in two places: the tray binary (10 s probe timeout, "slow to respond" label, Rust) and the packaged server (grade sweep deferred behind the initial reconcile, TS). The running tray on :4100 is v1.16.1 and has neither.
  Use the normal release process (see the release-process note: branch + PR, CHANGELOG heading, annotated tag, `gh release`), then let the updater install it or run the installer.
- [ ] Verify on the next reboot: the tray should read "slow to respond" (not "not responding") while indexing, and `~/.minder/logs/minder.log` should show the reconcile finishing in noticeably under the previous ~11.5 min
  Compare `indexer_runs` (the latest `reconcile` row's duration) against 689 s from 2026-09-29. If it did not shorten, the grade sweep was not the main contributor and #586 (worker fallback) is the next lead.
- [ ] Decide what to do about #586 (ingest worker falls back to in-process every boot) and the recurring re-parse in #585 — neither is fixed by this branch

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
