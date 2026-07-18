# Service Mode + Tray App (Phase A → Phase C1)

**Date:** 2026-07-16 · **Status:** APPROVED — execution not started
**Decision record:** Turn Project Minder from "web app you start with `pnpm dev`" into a
persistent, auto-starting local service with a native tray app, on Windows / macOS / Linux —
**without leaving the TypeScript/Node stack**. A full rewrite (Rust/Go) was evaluated and
rejected: the workload is I/O-bound glue (fs watchers, `git`/`gh` subprocesses, JSONL parsing,
SQLite), and the codebase's value is ~124k lines of hardened domain logic + ~52k lines of tests
that a rewrite would forfeit.

## Locked decisions (do not re-litigate in sub-agent sessions)

1. **Phase A first** (service-ify the existing Next server), **then Phase C Model 1**
   (Tauri v2 tray app that *owns* the server as a supervised sidecar).
2. **Phase B (daemon/UI split) is DEFERRED indefinitely.** It is *not* a prerequisite for the
   tray app — Tauri's sidecar can be the whole Next server. Do not build it.
3. **Login-scoped, per-user autostart — never machine/boot-scoped.** Everything Minder reads
   (`~/.claude`, `C:\dev`, `~/.minder`) lives in the user profile; telemetry only flows while
   the user is logged in. On Windows this means a **Scheduled Task (logon trigger)**, NOT a
   Windows Service (services need stored credentials to run as a user and default to
   LocalSystem, which breaks all `~` paths). macOS: launchd LaunchAgent. Linux: systemd
   **--user** unit.
4. Once the tray app ships, it becomes the recommended supervisor on desktops; the Phase A
   OS-level wrappers remain as the headless/no-tray install path.

## Execution model (multi-session, model-tiered)

This plan is designed to be executed by sub-agents spawned across many sessions, because the
supervising session may be short-lived and the supervising model (Fable) is expensive.

- **Supervisor** (Fable or Opus): reads this doc, picks the next unblocked task from the
  Status table, spawns one sub-agent per task with the recommended model, reviews the diff,
  runs the verification gates, and updates the Status table. The supervisor writes little or
  no code itself.
- **Sub-agent models:**
  - **Haiku** — docs, changelog, help pages, mechanical config edits.
  - **Sonnet** — well-scoped code with an existing in-repo pattern to mirror.
  - **Opus** — new architecture, process-lifecycle code, Rust, CI/packaging matrices.
- **One branch + one PR per task** (e.g. `svc-a1-bootstrap`). Squash-merge. Never push to main.
- **Codex + Copilot review bots run on every PR.** After CI is green, wait for the bot
  reviews and run `/pr-resolve` on the PR — merge only once all findings are fixed or
  explicitly dismissed with a reason. For complex new code, consider a `/simplify` pass
  before opening the PR. (Added 2026-07-17 after #281 merged ahead of its bot findings.)
- **Every task must pass the repo gates before its PR:** `pnpm typecheck` and `pnpm test`
  (report exact pass counts; baseline at plan time: **3,351 tests**). UI-touching tasks also
  need `pnpm build`.
- **Repo conventions apply** (see CLAUDE.md): CHANGELOG.md under `[Unreleased]` for any
  behavior change; `docs/help/` + `public/help/` mirror + `help-mapping.ts` for user-facing
  features; MANUAL_STEPS.md for anything the developer must do by hand.
- **After finishing a task, the sub-agent updates the Status table in THIS file** (check the
  box, add PR #) in the same PR. This table is the cross-session source of truth.

## Grounded facts (verified 2026-07-16 — saves sub-agents rediscovery)

- Version 1.2.0, `pnpm@10.30.3`, Next.js 16 (Turbopack), port **4100**
  (`dev`/`start` scripts pass `-p 4100`; `predev`/`prebuild` run `build:worker`).
- **Instrumentation entry point (corrected during A1):** a ROOT-level `instrumentation.ts` →
  `instrumentation-node.ts` pair already existed (dispatcher + DB-ingest startup) and a new
  `src/instrumentation.ts` silently loses to it. A1 wired `runBootstrap()` into
  `instrumentation-node.ts`'s `startIngest()` instead — later tasks extend that path.
- **OTel ingest is push-based HTTP** inside the Next server: `src/app/api/otel/v1/logs/route.ts`,
  `.../metrics/route.ts`. There is no separate collector process. Serving these while headless
  is the core durability win of Phase A.
- **Background singletons initialize lazily from routes today** — nothing collects until a
  browser hits the dashboard:
  - `gitStatusCache` (`src/lib/gitStatusCache.ts:142`) and `githubActivityCache`
    (`src/lib/githubActivityCache.ts:361`) are enqueued by
    `src/app/api/projects/route.ts` (~lines 67–96) after a scan.
  - `manualStepsWatcher` singleton at `src/lib/manualStepsWatcher.ts:330`
    (class at line 91; helpers `manualStepEntryKey`, `diffNewManualStepEntries`,
    `shouldHandleWatchEvent` are exported and unit-tested).
  - Also route-initialized: `mcpHealthCache.ts`, `mcpConfigWatcher.ts`, `skillUpdateCache.ts`,
    `claudeStatus/cache.ts`. Grep for their route callers before wiring.
- `next.config.ts` has `serverExternalPackages: ["better-sqlite3", "web-push",
  "claude-code-lint"]` and **no `output` setting yet** (C0 adds `standalone`).
- Demo mode: `MINDER_DEMO=1` or `demoMode` flag — bootstrap must respect it (demo mode is
  read-only synthetic data; background collectors should not run).
- DB: `~/.minder/index.db` via optional-dep `better-sqlite3`; routes use `probeInitStatus()`
  from `@/lib/data` (never `initDb()` directly). Graceful degradation when the native module
  is absent must be preserved.
- Existing health-ish route: `src/app/api/home-health/route.ts` (check before adding a new one).
- Task dispatcher: `src/lib/tasks/dispatcher.ts` (`isDispatcherRunning` at line 35) — include
  in shutdown handling.

---

## Phase A — Service-ify the monolith

### A1 — Boot-time initialization (`instrumentation.ts`)  · **Sonnet** · no deps

**Objective:** the server collects from the moment it starts — no browser visit required.

**Steps:**
1. Create `src/instrumentation.ts` exporting `register()`. Guard with
   `process.env.NEXT_RUNTIME === "nodejs"` and use a **dynamic import** of the bootstrap
   module inside the guard (instrumentation is evaluated in non-Node contexts too).
2. Create `src/lib/bootstrap.ts` with an idempotency guard (`globalThis` flag — `register()`
   can fire more than once under dev/HMR). It should, in order: skip entirely in demo mode;
   `probeInitStatus()`; run the project scan to warm the cache; enqueue `gitStatusCache` /
   `githubActivityCache` by mirroring the enqueue logic in `src/app/api/projects/route.ts`
   (extract a shared helper rather than duplicating); start `manualStepsWatcher`; start the
   MCP config watcher / health cache if their route-side starters are idempotent (read them
   first).
3. **Gating:** default ON when `NODE_ENV === "production"`, opt-in via `MINDER_BOOTSTRAP=1`
   for dev (a full scan on every dev restart is hostile). Env override `MINDER_BOOTSTRAP=0`
   disables everywhere.
4. Log one structured line per subsystem started (console for now; A2 adds file logging).

**Acceptance:** `pnpm build && pnpm start` shows bootstrap logs and `/api/git-status` returns
populated results without any prior page load; `pnpm dev` behavior unchanged by default;
gates pass; unit tests for the gating/idempotency logic (pure parts) in `tests/bootstrap.test.ts`.

### A2 — Lifecycle: graceful shutdown, health endpoint, file logging  · **Opus** · needs A1

**Objective:** the process can be supervised: probed, stopped cleanly, and debugged from logs.

**Steps:**
1. `src/lib/lifecycle.ts` — a disposer registry (`onShutdown(name, fn)`) + a `shutdown()`
   that runs disposers with a hard timeout (~5s). Wire `process.on("SIGINT"|"SIGTERM")` and
   Windows `SIGBREAK`; make registration idempotent. Wire into bootstrap (A1).
2. Register disposers: `manualStepsWatcher` stop; `gitStatusCache`/`githubActivityCache`
   `dispose()` (both already have generation-guarded `dispose()`); dispatcher stop if running;
   SQLite close + WAL checkpoint via `src/lib/db/connection.ts` (respect the
   better-sqlite3-absent path).
3. `GET /api/health` — `{ status, version, uptimeSec, db: probeInitStatus() summary, demoMode,
   watchers: {...counts} }`. Reuse/extend `home-health` if it already fits; keep response
   dependency-free and fast (no scan). This is the contract the tray app (C1) polls.
4. File logging: `src/lib/serviceLog.ts` — append JSON-lines to `~/.minder/logs/minder.log`,
   size-rotated (5 MB × 3). Only active when bootstrap runs (service mode), tee to console.
   No new deps unless truly needed.

**Acceptance:** start prod server → Ctrl+C → disposer log lines appear, process exits < 5s,
no orphaned `fs.watch` handles; `/api/health` responds < 100ms; gates pass; tests for rotation
math + disposer ordering.

### A3 — Per-OS autostart wrappers + install scripts  · **Sonnet** · needs A2

**Objective:** `pnpm service:install` registers Minder to start at login on the host OS.

**Steps:**
1. `scripts/service/` — templates: Windows Scheduled Task XML (logon trigger, run
   `node <repo>/.next/standalone-or-start` — for Phase A, `pnpm start` via an absolute
   `node`/`pnpm` path; C0 later switches this to the standalone `server.js`); macOS
   `com.minder.dashboard.plist` LaunchAgent (`RunAtLoad`, `KeepAlive`, stdout/err →
   `~/.minder/logs/`); Linux `minder.service` systemd **user** unit (`Restart=on-failure`).
2. `scripts/service.mjs` — platform-detecting `install | uninstall | status | start | stop`
   (uses `schtasks` / `launchctl` / `systemctl --user`). Substitute absolute paths into
   templates at install time (resolve `process.execPath` for node). Refuse to install if the
   build is missing; print how to build.
3. package.json: `service:install`, `service:uninstall`, `service:status`, `service:start`,
   `service:stop`.
4. MANUAL_STEPS.md entry for the one-time registration per machine; note Windows may prompt
   for consent.

**Acceptance:** on the dev machine (Windows): install → task visible in `schtasks /query` →
log off/on or `service:start` → `/api/health` responds → uninstall cleans up. macOS/Linux
templates are reviewed-only (no CI for them yet — noted as residual risk). Gates pass.

### A4 — Docs, changelog, port-conflict polish  · **Haiku** · needs A3

**Steps:** `docs/help/service-mode.md` (+ `public/help/` mirror; add to `help-mapping.ts`
only if a UI surface links it); CHANGELOG entries for A1–A3; README/Setup-page note; document
the port-4100 collision (service running + `pnpm dev` → dev fails to bind; document
`pnpm service:stop` first, and check whether a `MINDER_PORT` override is already respected
anywhere before promising one).

**Acceptance:** docs build/lint clean; gates pass.

---

## Phase C (Model 1) — Tauri tray app that owns the server

### C0 — Standalone server build  · **Sonnet** · independent of A (can run in parallel)

**Objective:** a self-contained, movable server directory — the sidecar payload.

**Steps:**
1. Add `output: "standalone"` to `next.config.ts`. Verify dev/start unaffected.
2. `scripts/package-standalone.mjs` — assemble `dist/minder-server/`: `.next/standalone/*`
   plus the required manual copies (`.next/static` → into standalone's `.next/static`,
   `public/` → `public/`). Verify `better-sqlite3`'s `.node` prebuilt is present in the pruned
   `node_modules` (it's in `serverExternalPackages`, so it should copy — **verify, don't assume**).
3. Standalone server reads `PORT`/`HOSTNAME` env — script/docs must set `PORT=4100`,
   `HOSTNAME=127.0.0.1`.
4. Smoke-test: run `node dist/minder-server/server.js` from a shell whose cwd is elsewhere;
   hit `/api/health`, `/api/projects`, one OTel POST.

**Acceptance:** standalone dir runs with system Node and NO repo `node_modules`; gates pass.
**Risk to record in the PR:** the bundled prebuilt's ABI must match the Node major that runs
it — pin the expected Node major in the script and check `process.version` at startup.

### C1 — Tauri v2 scaffold: tray + sidecar supervision  · **Opus** · needs A2 + C0

**Objective:** a tray app that spawns, supervises, and exposes the server.

**Steps:**
1. `src-tauri/` via `pnpm dlx create-tauri-app` conventions (Tauri v2, no bundled frontend —
   this is a tray-only app; no main window at launch).
2. Plugins: `tauri-plugin-single-instance` (second launch → focus/no-op),
   `tauri-plugin-shell` or sidecar API for the server process.
3. Sidecar: spawn `node <resource-path>/minder-server/server.js` with
   `PORT=4100 HOSTNAME=127.0.0.1`. For dev iteration, allow `MINDER_TRAY_ATTACH=1` to skip
   spawning and attach to an already-running server. Supervise: restart on crash with
   exponential backoff (cap ~30s); on quit, kill the **process tree**
   (`taskkill /F /T` on Windows — mirror `processManager.ts`'s approach).
4. Tray menu: **Open Dashboard** (opens default browser at `http://localhost:4100` — do NOT
   embed a webview in v1; the browser already works), **Status** (from polling
   `/api/health` every ~15s; reflect up/degraded/down in the tray icon), **Restart server**,
   **View logs** (open `~/.minder/logs/`), **Quit**.
5. Port-conflict handling: if 4100 is already bound at startup, probe `/api/health` — if it's
   a healthy Minder (e.g. Phase A task still registered), attach instead of spawn, and surface
   "attached to existing service" in the menu.

**Acceptance:** on Windows: launch → tray icon → server up → dashboard opens → kill server
process manually → auto-restart observed → Quit leaves no orphan node processes
(`tasklist | findstr node`). Rust code passes `cargo clippy`. Repo gates pass (TS untouched
or minimal).

### C2 — Autostart toggle  · **Sonnet** · needs C1

`tauri-plugin-autostart`; tray menu checkbox "Start at login", persisted (plugin handles OS
registration). When the tray app is installed, `docs` should steer desktop users here and note
that the Phase A scheduled-task path should be uninstalled to avoid double supervision
(C1's attach logic makes the failure mode benign, but say it anyway).

**Acceptance:** toggle survives restart; login test on Windows.

### C3 — Native notifications for manual steps  · **Sonnet** · needs C1

Rust-side poller (tokio task) against `GET /api/manual-steps/changes?since=<iso>` (endpoint
exists; read `src/app/api/manual-steps/changes/route.ts` for the shape) → OS toast via
`tauri-plugin-notification`, click opens the dashboard `/manual-steps` page. Tray menu toggle
to mute. Keep `since` cursor in app state; don't re-toast on restart (persist last cursor).

**Acceptance:** append a MANUAL_STEPS entry in a watched project → toast within ~60s
(watcher poll) + poll interval.

### C4 — Packaging CI  · **Opus** · needs C1

GitHub Actions workflow (release-tag triggered): matrix `windows-latest` / `macos-latest` /
`ubuntu-latest`; each job runs `pnpm build` + `package-standalone` + downloads a **pinned**
Node runtime for the target platform, places both as Tauri resources, runs `tauri build` →
NSIS `.exe` (Windows), `.dmg` (macOS), `.AppImage` + `.deb` (Linux); upload artifacts to the
release. Unsigned for now (C5). Document artifact sizes (Node runtime + standalone will be
~100 MB+ — acceptable, note it).

**Acceptance:** a tag build produces all three installers; Windows installer manually
verified end-to-end.

### C5 — Signing + updater (OPTIONAL — user decides)  · **Sonnet** · needs C4

`tauri-plugin-updater` + signing. Heavy on MANUAL_STEPS (Apple Developer account + notarization
for macOS; Windows cert optional — unsigned hits SmartScreen, fine for personal use).
**Do not start without explicit user go-ahead** — it costs money ($99/yr Apple) and may not be
needed for a personal tool.

### C6 — Docs + changelog for the tray app  · **Haiku** · needs C2/C3

`docs/help/tray-app.md`, README install section, CHANGELOG, MANUAL_STEPS for first-install.

---

## Risks & gotchas (read before starting any task)

- **Dev/HMR double-execution:** `instrumentation.ts` `register()` and module-level code can
  run multiple times in dev — every starter must be idempotent (`globalThis` guards, the
  existing cache `generation`/`dispose()` pattern is the house style).
- **better-sqlite3 is an optional dep with a native binary.** Bootstrap, shutdown, and the
  standalone package must all keep the degrade-gracefully path working (`MINDER_USE_DB=0`
  and module-absent).
- **Windows process trees:** Next/Turbopack spawn children; naive kill orphans them. Always
  `taskkill /F /T` (see `processManager.ts`).
- **Port 4100 is a singleton resource:** Phase A service, tray sidecar, and `pnpm dev` all
  want it. C1's probe-then-attach is the mitigation; docs must be explicit.
- **Demo mode:** never start collectors/watchers under `MINDER_DEMO=1`.
- **Pre-commit hook** runs typecheck + full tests — budget a few minutes per commit; do not
  bypass with `--no-verify`.
- **Worktree sub-agents:** planning files (TODO/MANUAL_STEPS/INSIGHTS + this plan's Status
  table) are canonical to the **main tree** — never edit worktree copies.

## Status (living checklist — update in the same PR as the work)

| Task | Model | Depends on | Status | PR |
|------|-------|-----------|--------|----|
| A1 bootstrap via instrumentation.ts | Sonnet | — | ☑ done | #281 |
| A2 shutdown + /api/health + logging | Opus | A1 | ☑ done | #290 |
| A3 per-OS autostart wrappers | Sonnet | A2 | ☑ done | #291 |
| A4 docs + polish | Haiku | A3 | ☑ done | #293 |
| C0 standalone build | Sonnet | — (parallel-safe) | ☑ done | #285 |
| C1 Tauri tray + sidecar | Opus | A2, C0 | ☑ done | #294 |
| C2 autostart toggle | Sonnet | C1 | ☑ done | #298 |
| C3 native notifications | Sonnet | C1 | ☑ done | #300 |
| C4 packaging CI | Opus | C1 | ☑ done | #301 |
| C5 signing + updater (optional) | Sonnet | C4 | ☐ blocked on user decision | |
| C6 tray docs | Haiku | C2, C3 | ☑ done | #302 |

**Suggested session grouping:** Session 1: A1 + C0 (independent, parallelizable). Session 2:
A2. Session 3: A3 + A4. Session 4: C1 (largest single task). Session 5: C2 + C3. Session 6:
C4 (+ C6). Each session: supervisor spawns the sub-agent(s), verifies, merges, updates this table.
