# Project Minder Tray App

Run Project Minder as a native desktop tray application that manages the dashboard server, displays notifications, and provides one-click access to your projects.

The tray app is the recommended way to run Project Minder on desktop machines. It packages the dashboard server with an embedded Node runtime, runs the server as a managed child process, and provides a system tray menu for control.

## Quick Start

### Installation

Download the installer for your platform from [GitHub Releases](https://github.com/joshuatownsend/project-minder/releases) — look for version tags starting with `v` (e.g., `v1.3.0`).

**Available installers:**
- **Windows:** `Project Minder*.exe` (NSIS installer, unsigned — expect a SmartScreen warning on first run)
- **macOS (Apple Silicon):** `Project Minder*_aarch64.dmg` — open and drag to Applications
- **macOS (Intel):** `Project Minder*_x64.app.tar.gz` — extract, then drag the `.app` to Applications (no DMG for Intel: creating one fails deterministically on the Intel build runners). The app is unsigned, so on first launch right-click the app → Open → Open.
- **Linux:** `minder*.AppImage` or `minder*.deb` (built on ubuntu-22.04 for broad glibc compatibility)

**First-run steps:**
1. Download and run the installer for your OS.
2. On Windows with SmartScreen warning: click "More info" → "Run anyway" (unsigned installers trigger this).
3. Launch the tray app from your applications menu or system tray.
4. A tray icon appears immediately; click "Open Dashboard" to access the web UI.

### Autostart on Login

By default the tray app starts manually each session. To enable automatic startup:
1. Click the tray icon and select **Start at login**.
2. The checkbox is retained across restarts.

(The setting is stored in the OS autostart mechanism — Windows registry Run key, macOS LaunchAgent, or Linux XDG autostart .desktop entry — Project Minder does not persist this itself.)

### Local Development

To run the tray app from source during development:

1. **One-time setup:** Fetch the bundled Node runtime (SHA-256 verified from nodejs.org):
   ```bash
   node scripts/fetch-node-runtime.mjs
   ```
   This downloads Node 22.12.0 and places it at `dist/node/` — the tray uses this bundled runtime instead of your PATH node.

2. **Build the server payload:**
   **Important:** The payload's `better-sqlite3` native binary is ABI-tied to your Node version. Ensure you're using Node 22.x (matching the bundled 22.12.0 runtime) by running `node --version` first. If your active Node differs, either switch to Node 22 before building, or set `MINDER_NODE_PATH` to point `pnpm tray:dev` to the same Node major you used for the build.
   ```bash
   pnpm build && pnpm package:standalone
   ```
   This creates `dist/minder-server/` — the compiled Next.js app with dependencies bundled.

3. **Start the tray app:**
   ```bash
   pnpm tray:dev
   ```
   The app launches immediately and manages the server.

Both `dist/node` and `dist/minder-server` must exist for `pnpm tray:dev` to start — the resource paths are built into the tray binary.

## Tray Menu Reference

Click the tray icon to open the menu. The menu resets its status display every 15 seconds by polling `/api/health`.

| Menu Item | Behavior | Notes |
|-----------|----------|-------|
| **Open Dashboard** | Opens your default browser to `http://localhost:4100` | Launches the web UI. Click this to navigate to any page (the first suggested destination). |
| **Status** | Display-only line showing current server state | Updates every 15s: "Status: starting…" initially, then "Status: running (:4100)", "Status: degraded (:4100)", or "Status: not responding (:4100)"; suffix notes added when attached to an existing server. |
| **Start at login** | Checkbox that registers/unregisters OS autostart | Checked state syncs with the OS (Windows registry Run key, macOS LaunchAgent, Linux XDG autostart .desktop entry). Reboot is not required. (This is distinct from Phase A service mode, which uses Windows Task Scheduler / macOS LaunchAgent / Linux systemd.) |
| **Mute notifications** | Checkbox that suppresses new-manual-steps toasts | When checked, `MANUAL_STEPS.md` changes no longer trigger OS notifications. The mute flag persists to disk. |
| **Restart server** | Graceful server restart | **Disabled when in attach mode** (see [Modes](#modes) below). Blocks ~6s on graceful shutdown. Useful when the server becomes unresponsive. |
| **View logs** | Opens `~/.minder/logs/` directory in your file manager | Reveals the rotating `minder.log` file for troubleshooting. |
| **Quit** | Cleanly stops the tray app | Gracefully shuts down the spawned server (or leaves an attached server untouched), then exits. No orphan processes. |

## Notifications

When new entries are added to `MANUAL_STEPS.md` anywhere in your projects, the tray app sends an OS notification (Windows toast, macOS banner, Linux libnotify alert).

**Polling:** Every ~30 seconds, the tray checks the API endpoint `GET /api/manual-steps/changes` (server-side watcher batches its own filesystem scan up to 60s, so combined worst-case is well under 90s).

**Cursor & persistence:** The tray remembers how far it has read via a small state file at `~/.minder/tray-notify.json` — when the app restarts, it resumes from where it left off instead of replaying or re-toasting old entries.

**Mute flag:** The "Mute notifications" checkbox toggles whether toasts appear. The flag is also persisted to the same state file.

**Click-to-open:** Notification clicks are **not** wired up (the tray has no window or webview to handle them). Use the "Open Dashboard" menu item to navigate to your projects instead.

## Modes: Spawn vs. Attach

The tray app decides at startup how to manage the server:

### Spawn Mode
- The tray **owns** the server process and keeps it alive.
- When the server crashes, the tray auto-restarts it with exponential backoff (base 500ms, capped at 30s).
- **Restart server** menu item is enabled.
- Quit gracefully stops the server, then exits.

**When:** The default. Used when port 4100 is available.

### Attach Mode
- Something else already owns the server (e.g., a Phase A service is running, or `MINDER_TRAY_ATTACH=1` is set).
- The tray **observes** only — it probes `/api/health` and displays status, but never spawns or kills the process.
- **Restart server** menu item is disabled with a note "(attached — n/a)".
- Quit exits cleanly without touching the server.

**When:** Automatically triggered if port 4100 is already bound at startup, or if `MINDER_TRAY_ATTACH=1` is set.

**Recommendation:** If you previously installed the Phase A scheduled-task/service:
1. **On Windows:** If the service is currently running, run `pnpm service:stop` first (uninstall only removes the registration without stopping the running process).
2. Run `pnpm service:uninstall` to remove the service registration.
3. Launch the tray app.

If the tray was already running and attached to that service, relaunch it afterward — otherwise it stays observing the now-stopped server. See [Service Mode](service-mode.md) for details.

## Environment Variables

The tray app respects these optional environment variables (most have sensible defaults):

| Variable | Default | Effect |
|----------|---------|--------|
| `MINDER_TRAY_PORT` | `4100` | Port the tray spawns the server on and probes for health. Change this to run the tray app alongside your live service without conflicts (development only). |
| `MINDER_TRAY_ATTACH` | unset | Set to `1` to force attach mode at startup (observe an existing server, never spawn). Used for dev iteration. |
| `MINDER_NODE_PATH` | bundled or `node` | Explicit path to the `node` binary. If unset, the tray uses the bundled Node runtime (preferred in packaged installs) or falls back to `node` on PATH (dev). An explicit override takes precedence over the bundled runtime. |
| `MINDER_SERVER_DIST` | bundled `minder-server/` | Path to the `dist/minder-server/` directory (dev override). Takes precedence over the bundled payload. Used when you rebuild the server during development. |
| `MINDER_STATE_DIR` | `~/.minder/` | Forwarded to the spawned sidecar (server) to relocate its config (.minder.json) and cache state away from the read-only bundled payload. **Database files `index.db` and `tasks.db` always stay in `~/.minder`** regardless of this variable (they hard-code `~/.minder` from `os.homedir()`). The tray's own notification state (cursor, mute flag) also stays in `~/.minder/tray-notify.json`, independent of this variable. |

**Windows:** On Windows, set these in your user environment variables (System Properties → Environment Variables) or in a `.cmd` batch file that launches the app.

**macOS/Linux:** Set these in your shell's `~/.bash_profile`, `~/.zshrc`, or equivalent before launching the tray.

## Troubleshooting

### Tray icon doesn't appear

1. **Check the app is running:** Look for a `minder` or `Project Minder` process in your task manager / Activity Monitor / `ps`.
2. **Check for early startup errors:** Launch the tray app from a terminal (Windows Command Prompt, macOS Terminal, or Linux shell) to see `[minder-tray]` stdout/stderr output directly. Early failures (missing bundled payload, bad Node path, server.js crash before bootstrap) don't reach `~/.minder/logs/minder.log` — they only appear in the tray's console output.
3. **Check the server log:** If the tray appears but the server isn't running, open `~/.minder/logs/minder.log` for errors (the log file is created after the server bootstrap starts).
4. **Restart the tray:** Kill the process and relaunch the installer or the app from your applications menu.
5. **Port conflict:** If port 4100 is held by another process, the server may fail to start. See [Port Held by Another App](#port-held-by-another-app).

### Status says "degraded" or "not responding" (or stays on "starting…" for too long)

1. **Check the server log:** `~/.minder/logs/minder.log` will show any startup errors or crashes.
2. **Check for port conflicts:** Run `netstat -ano | findstr :4100` (Windows), `lsof -i :4100` (macOS/Linux).
3. **Try restarting:** Click the tray menu and select "Restart server" (if not in attach mode).

### Notifications don't appear

1. **Check if muted:** Is "Mute notifications" checked in the tray menu? Uncheck it.
2. **Check permissions:** Ensure the OS allows notifications from the tray app (system settings vary by OS).
3. **Check the API:** Verify the server is running by clicking "Open Dashboard" — if the dashboard loads, the API is working.
4. **Check for errors:** Look in `~/.minder/logs/minder.log` for notification-poller errors.

### Port held by another app

If port 4100 is already in use:

- **With `pnpm dev` running:** Stop the dev server first (`pkill -f "next dev"` on macOS/Linux).
- **With a Phase A service running:** Run `pnpm service:stop`, then relaunch the tray app. Or set `MINDER_TRAY_PORT=4200` and access the tray dashboard at `http://localhost:4200`.
- **With an old tray instance:** Kill the old tray process, then relaunch.

When the port is already bound, the tray **automatically enters attach mode** (if the server at that port is a Minder instance). The menu shows "Restart server (attached — n/a)" and the tray observes instead of spawning.

### SmartScreen warning on Windows

Unsigned installers trigger this warning. This is expected and normal.

- Click **More info** at the bottom of the warning.
- Click **Run anyway**.
- The installer will proceed.

This applies to the **initial download** only. Once installed, the app updates itself and verifies every update against the project's signing key — see [Updates](#updates). Signed installers, which would remove this warning, are still planned.

### Tray app won't quit cleanly

If Quit hangs, the server may be unresponsive to the graceful-shutdown signal. Force-kill the process via task manager and relaunch. The SQLite database is resilient to unclean stops (WAL recovery on next startup).

## Updates

The tray app updates itself from GitHub Releases.

- **Automatic check** — every ~6 hours (piggybacked on the existing health-poll timer, so there's no extra background thread). If a new version exists you get a desktop notification. The check **never installs on its own**: this app is supervising a dashboard server you may be actively using, and an unannounced restart would drop in-flight scans and any dev servers it's managing.
- **Installing** — choose **Check for updates…** in the tray menu. That downloads and installs the update, stops the server cleanly, and relaunches.

Each update is a full ~100 MB download; Tauri does not do differential updates.

### What's verified, and what isn't

Update payloads are signed with the project's minisign key, and your installed app will refuse any update it can't verify against that key. This is what protects you from a tampered update.

That is **separate** from OS code signing, which Project Minder does not yet have. The first time you download an installer, Windows SmartScreen or macOS Gatekeeper will still warn you — see [SmartScreen warning on Windows](#smartscreen-warning-on-windows). Signing the installers is planned but not done; the two mechanisms are unrelated, and neither substitutes for the other.

### Linux: `.deb` cannot self-update

If you installed the `.deb`, the updater will report `Currently only an AppImage can be updated`. This is by design, not a bug — a system package manager owns those files, so an app that rewrote them would fight it. Update by downloading the next `.deb` from the Releases page, or switch to the **AppImage**, which self-updates normally.

## Building Installers Locally

Installers are normally built by CI: pushing a `v*` tag runs `.github/workflows/release-installers.yml`, which builds all four platform targets and attaches them to the GitHub Release.

To reproduce that build on your own machine — to test a change to the packaging chain, or to produce an installer from an untagged commit — use:

```bash
pnpm release:local
```

This runs the same five steps CI does, in the same order:

1. `pnpm build` — the Next app (its `prebuild` hook builds the worker)
2. `pnpm package:standalone` — the Node sidecar payload into `dist/minder-server`
3. `node scripts/verify-payload-hygiene.mjs` — the gate that fails the build if `.git`, `.env*`, or `.claude/` leaked into the payload
4. `node scripts/fetch-node-runtime.mjs` — the pinned, SHA-256-verified Node runtime into `dist/node`
5. `pnpm tauri build --bundles <targets>` — the installers

Finished installers are listed with their paths and sizes at the end, under `src-tauri/target/release/bundle/`.

### Options

| Flag | Effect |
|------|--------|
| `--bundles <list>` | Comma-separated Tauri targets (e.g. `nsis`, `deb,appimage`). Defaults to the host OS's natural set. |
| `--skip-build` | Reuse the existing `.next` and `dist/minder-server` instead of rebuilding. |
| `--skip-node` | Reuse the existing `dist/node` instead of re-downloading (~80 MB). |
| `--dry-run` | Print the plan and exit without running anything. |

`--skip-build` and `--skip-node` are for iterating on the Tauri layer, where re-running the slow earlier steps buys nothing. The hygiene gate always runs — it is the backstop that keeps secrets out of a shipped installer, so it is deliberately not skippable.

### Version stamping

`src-tauri/tauri.conf.json` is checked in with a placeholder version of `0.1.0`; the real version is stamped from `package.json` at build time. `pnpm release:local` performs that same stamp and then restores the file, so it leaves no diff in your working tree.

This matters more than it looks: an installer built without the stamp reports itself as version `0.1.0` forever. Once auto-updates ship, such a build would consider itself permanently out of date and re-download every release in a loop.

If `HEAD` carries a `v*` tag, the script requires it to agree with `package.json` and fails loudly otherwise — the same mistagged-release guard CI applies. On an untagged commit it says so and proceeds, since building a release candidate before tagging is the normal local workflow.

### Signing

`pnpm release:local` produces **unsigned** installers, exactly as CI does today. Windows will show a SmartScreen warning and macOS a Gatekeeper warning for any build produced this way.

Separately, if `TAURI_SIGNING_PRIVATE_KEY` is not set in your environment, the script builds **without updater artifacts** and says so. The installer works normally; it just can't self-update, which is what an unsigned local build already implied. Set the variable to produce a releasable build:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$env:USERPROFILE\.tauri\minder.key"
```

Tauri does not read `.env` files for this — it must be a real environment variable.

## Comparison with Service Mode

Project Minder offers two ways to run continuously:

| Aspect | Tray App | Service Mode |
|--------|----------|--------------|
| **Platform** | Desktop (Windows / macOS / Linux) | Any (server / shared machine / desktop) |
| **Autostart** | Click "Start at login" checkbox in tray menu | Run `pnpm service:install` (scheduled task / LaunchAgent / systemd) |
| **Status visibility** | Tray icon with menu showing status and controls | No UI (runs headless) — check via `service:status` command |
| **Restart** | Click "Restart server" in tray menu | `pnpm service:stop && pnpm service:start` |
| **Notification support** | Yes (new manual steps) | No built-in notifications |
| **Resource overhead** | Minimal (tray icon + small polling loop) | Minimal (no UI) |
| **Recommended for** | Desktop users who want visual feedback and easy control | Servers / headless machines / shared systems |

If you're on a desktop, the tray app's checkbox and menu are simpler than service-mode commands. If you're on a server or shared machine, service mode requires no UI and can be managed entirely via commands.

## Performance & System Impact

The tray app is lightweight:
- **Polling overhead:** 15-second health checks and ~30-second notification polls. Network-only, no subprocess spawning.
- **CPU:** Idle when not polling. No background re-scanning (the server's internal watcher handles that).

The bundled Node runtime (~80 MB uncompressed) and standalone server payload dominate the ~100+ MB installer size. This is expected for a "no dependencies required" desktop app.
