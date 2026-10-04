## 2026-10-03 18:00 | slow-boot | Verify the clean-shutdown marker and single quick_check after installing the #588 fix (PR #601)

- [x] After the release containing PR #601 is installed, do a graceful tray Quit (or restart from the tray), then check `~/.minder/index.db.clean`
  Its mtime/`closedAt` should be the moment of the stop. Before the fix it was stuck at 2026-09-30 13:14Z because a slow `ingest` disposer spent the whole 5 s shutdown budget and the `sqlite` close was skipped. Also check `minder.log`: the `shutdown initiated` block should end with `disposer ok` for `sqlite`, no `skipped (shutdown budget exhausted)` lines.
  Result 2026-10-04 (v1.16.4): tray Quit at 11:52:58Z wrote `index.db.clean` (`closedAt` 11:52:58.921Z) 160 ms later; its size/mtime match `index.db`, WAL gone, so the next boot trusts it. Every disposer `ok` (`ingest` 53 ms, `sqlite` 94 ms). The next boots skipped the check: `db: probed` 1.2 s and 0.02 s (was 95 s), worker `initDb` 14-16 ms (was 31,401 ms), boot complete +43 s (was +151 s). First `/api/health` 200 came ~68 s after server start (port open at +2 s); the ~65 s project scan is now the longest remaining piece.
- [x] After an UNCLEAN stop (reboot, or `taskkill /F`), confirm only ONE `quick_check` runs at the next boot
  In `minder.log` the `watcher armed after N ms` line's `phaseMs.initDb` should be near 0 (it was 31,401 ms at the 2026-10-03 16:42 EDT boot, when the worker repeated the server's 95 s scan). `db: probed` (the server's own check) will still be slow after an unclean stop — that is expected until the tray handles Windows session end (not yet built).
  Result 2026-10-04 (v1.16.4): `Stop-Process -Force` on the server (PID 58232, 12:51:35Z) wrote no shutdown lines; the tray supervisor restarted it within ~2.4 s. Boot with a stale marker and a 6 MB WAL: the server's own check ran (`db: probed` 28.7 s, warm cache), the worker's did not (`initDb` **19 ms**, was 31,401 ms). DB healthy (`quarantineRuns` 0), 0 warn/error lines, ingest native, `crashesLastHour` 0. First `/api/health` answer ~110 s after server start (quick_check 28.7 s + scan ~50 s, event loop blocked) versus ~68 s after a graceful stop. Not tested: the cold-cache reboot case, where the server's check still takes ~95 s. Side finding: `eventsHandled` jumped to 8,666 within ~90 s of arming from access-time bumps, filed as #604.
- [ ] Decide on the follow-up: make a start-menu reboot run the graceful stop
  A reboot never reaches the server's disposers (the tray prevents implicit exits and does not handle Windows session end), so the marker still goes stale on every reboot. Needs a Rust change in `src-tauri/src/main.rs` / `supervisor.rs`, with a ~6 s stop window.

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
