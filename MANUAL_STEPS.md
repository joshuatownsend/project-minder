## 2026-09-29 23:10 | slow-boot | Get the #584/#585/#586 fixes into the running tray and verify them

- [ ] Install the v1.16.2 tray build (cut 2026-09-30; both fixes are in it: #587 and #589)
  The fixes live in two places, and the running tray on :4100 (v1.16.1) has none of them. Tray binary (Rust): 10 s health-probe timeout and the "slow to respond" label (#587). Packaged server (TS): the efficiency-grade sweep deferred behind the initial reconcile (#587), the ingest worker's start-handshake budget 60 s → 5 min, and durable failure logging (#589).
  Pushing the `v1.16.2` tag fires `release.yml` (creates the GitHub Release) and `release-installers.yml` (four platform bundles + `latest.json` for the updater, ~15-25 min). Install once the installers run is green, via the in-app updater or `Project.Minder.Tray_1.16.2_x64-setup.exe` from the release.
  For future releases: do **not** run `gh release create` — it races the workflow, and whichever loses fails (that is what turned the v1.9.0/v1.9.1 `Release` runs red). Let the tag create the Release, then swap in curated notes with `gh release edit vX.Y.Z --notes-file <file> --latest`.
- [ ] Reboot with the new build installed
  **#586 is deliberately still open until the four checks below pass** — the handshake timeout was never reproduced past 60 s in isolation, so the fix is unproven until then.
- [ ] Check 1 — tray: while the server is busy indexing it reads "slow to respond", not "not responding"
- [ ] Check 2 — `http://localhost:4100/api/health`: `ingest.mode` is `"worker"` with `crashesLastHour: 0`
  It was `"in-process"` on every boot since ~09-26.
- [ ] Check 3 — `~/.minder/logs/minder.log`: a `watcher armed after N ms` line and no failure lines
  Expect `watcher armed after N ms` with a `phaseMs` breakdown showing where startup time went (`initDb` was ~21 s warm on the 2.5 GB index), and **no** `start handshake failed` / `worker failed before ready` lines. If one is present it names the reason, elapsed time and timeout.
- [ ] Check 4 — `~/.minder/index.db` → `indexer_runs`: this boot has ONE `reconcile` row
  Every boot since 09-26 produced an aborted/orphaned ~60 s run followed by a second one. Also compare the row's duration with 689 s from 2026-09-29; if it did not shorten, the grade sweep was not the main contributor.
- [ ] If Check 2 still shows `"in-process"`: the log line from Check 3 is the diagnosis. The known follow-ups are #588 (the duplicate `PRAGMA quick_check` that spends ~21 s of the handshake budget on every start) and #585 (the usage cache is smaller than the corpus, so later whole-history sweeps still re-parse most of it).
  Unrelated: #590 is a flaky Windows CI test (10 s hook timeout in `subagentBillingBoundary.test.ts`), not a product problem.

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
