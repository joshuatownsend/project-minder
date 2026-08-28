# Service Mode

Run Project Minder as a background service that starts automatically at user logon, without requiring a terminal or browser.

Service mode is useful when you want Minder to run continuously in the background — indexing your projects, collecting session data, and hosting the dashboard API — without manual intervention. It enables headless operation on servers or shared machines.

## Quick Start

Build the standalone server, then install the autostart service:

```bash
pnpm build && pnpm package:standalone
pnpm service:install
pnpm service:start
```

(`service:install` only registers the logon task — without `service:start`, the server stays stopped until your next logon.)

Verify the service is registered:

```bash
pnpm service:status
```

Supported commands:
- `pnpm service:install` — register the service for autostart at user logon
- `pnpm service:uninstall` — remove the service registration. On Windows, run `pnpm service:stop` first if the service is currently running (uninstall only removes the registration without stopping the running process); on Linux (`systemctl --user disable --now`) and macOS (agent unload) uninstalling also stops the supervised server.
- `pnpm service:start` — start the service now
- `pnpm service:stop` — stop a running service
- `pnpm service:status` — show the current service status

## Desktop Users: Prefer the Tray App

If you're on a desktop machine, the Project Minder tray app's built-in "Start at login" checkbox is the recommended way to launch Minder automatically — it registers with the OS directly (no scheduled task, service, or install script to run) and the setting is remembered across restarts.

If you previously installed the Phase A scheduled-task/service described above, run `pnpm service:uninstall` **before** launching the tray app, to avoid double supervision (two processes trying to run the same dashboard). If the tray was already launched and attached to that older service, relaunch the tray after uninstalling — otherwise it's left observing the now-stopped server instead of spawning its own. Leaving both installed is not dangerous — the tray simply attaches to the existing server instead of spawning a second one — but doing it in this order keeps things simple.

### Keeping both: point them at the same server

If you *want* both (so the server survives quitting the tray), make sure they launch the **same** payload. By default `service:install` can only find the payload this repo built (`dist/minder-server`), while the installed desktop app runs its own bundled copy — so the same machine ends up serving a different build depending on which one won the boot, and the port collision decides which you get.

Point the service at an explicit payload with `--payload` (or `MINDER_SERVICE_PAYLOAD`). The directory must be the one containing `server.js`; if a Node runtime ships beside it (`../node/node.exe` on Windows, `../node/bin/node` on macOS/Linux, as the desktop app bundles), the service uses that runtime too, so it stays on the version the payload was built against.

With both installed and pointed at one payload, whichever starts first at logon binds the port and the other attaches — a race that no longer changes what you're running.

> #### Targeting the app's *own* install directory, and self-update
>
> Pointing the service straight at the installed app's bundle used to break the tray's self-update, and the tray now handles it for you. Worth understanding, because what it does is visible.
>
> The problem: the updater stops its **own** sidecar before exiting, precisely because an orphaned process holding `resources/node/node.exe` makes the installer fail on a locked file. But when the service owns the port the tray is in *attach* mode — where quitting deliberately leaves the running server untouched, because it is not the tray's process to kill. So the service kept the app's own bundled Node locked and the Windows installer could not overwrite it. On macOS and Linux the replacement succeeded but the service went on serving the **old payload from memory**, which is worse: the update looked like it worked.
>
> What the tray does now, when you install an update:
>
> - It reads the service registration (`~/.minder/service/service-manifest.json` on Windows, the LaunchAgent plist or systemd unit elsewhere) and checks whether it names a path **inside the app's own bundle**. A service running any other payload is not holding the app's files, and is left strictly alone.
> - If it does, the tray stops it — after gracefully stopping its own sidecar, and using the same identity check as `pnpm service:stop`, so a process it cannot positively identify as this installation's server is never killed.
> - It does **not** start the service back up. The registration is logon-triggered, so it returns by itself at your next logon; until then the port is free and the updated tray simply runs its own server. Restarting it here would race the relaunching tray for the port.
> - If a service is holding the bundle and the tray has no way to stop it, the update is **refused before anything is downloaded**, with a notification telling you to stop it yourself. It will not start an install it knows cannot finish.
>
> One visible side effect: stopping the service is a hard kill (on Windows that is the only option — see [Windows](#windows) below), so no clean-shutdown marker is written and **the first launch after an update re-verifies the index**. On a large `index.db` that first start is slow, once. It is not the cold-boot bug returning.
>
> Both arrangements below remain good ideas — they are now preferences rather than requirements:
>
> 1. **Give the service its own copy** of the payload, outside the app's install directory — `pnpm package:standalone` output, or a copy of the app's `minder-server` + `node` folders. Update it when you update the app.
> 2. **Let the tray own the server** — `pnpm service:uninstall`, and use the tray's "Start at login". Simplest, at the cost of the server stopping when you quit the tray.

## Operating System Details

### Windows

Registers a **Scheduled Task** with a logon trigger (not a Windows Service). A Scheduled Task runs in the current user's context and can access `~/.claude`, `C:\dev`, and other user-profile paths that a LocalSystem service cannot.

- **You may see a UAC prompt** when running `pnpm service:install` — this is normal. Accept it to allow Task Scheduler to register the task.
- **Verification:** Run `schtasks /query /tn MinderDashboard` to confirm registration, or use `pnpm service:status`.
- **Hard stop:** `pnpm service:stop` on Windows is a hard kill (no graceful shutdown signal). Task Scheduler loses track of the process immediately after logon, so there is no clean-signal path yet. Verify nothing else is listening on port 4100 before stopping. The boot-time reconcile + SQLite WAL recovery in A2 make an unclean stop safe for Minder's own data.

### macOS

Registers a LaunchAgent in `~/Library/LaunchAgents` (`com.minder.dashboard.plist`). The service runs at user logon via `launchctl`, in your user context.

- **PATH preservation:** The service captures `PATH` from your shell at install time and freezes it into the plist. If you later install Homebrew, switch Node versions (via nvm), or change `PATH`, re-run `pnpm service:install` to pick up the new value — launchd services don't inherit login-shell `PATH` changes.
- **Status:** Currently reviewed-only — no CI or hands-on verification on macOS yet.

### Linux

Registers a systemd user unit in `~/.config/systemd/user` (`minder.service`). The service runs at user logon via `systemctl --user`.

- **PATH preservation:** Like macOS, the service captures `PATH` at install time. Re-run `pnpm service:install` if your shell's `PATH` changes.
- **Status:** Currently reviewed-only — no CI or hands-on verification on Linux yet.

## Environment Variables

Service mode respects these environment variables:

| Variable | Value | Notes |
|----------|-------|-------|
| `MINDER_BOOTSTRAP` | `0`, `1` | Controls whether the boot-time scan / cache warm-up runs. Default is on in service mode. Set to `0` to disable. |
| `NODE_ENV` | `production` | Automatically set by the service scripts; do not override. |
| `MINDER_USE_DB` | `0` | Optional: set to disable the SQLite index and fall back to direct JSONL parsing. Default is on (uses the index). |
| `MINDER_DEMO` | `1` | Optional: enable demo mode with synthetic fixtures. Default is off. |
| `MINDER_SERVICE_PAYLOAD` | path | Install-time only: directory containing the `server.js` to install the service against, instead of the repo's `dist/minder-server`. Equivalent to `--payload`. See [Keeping both](#keeping-both-point-them-at-the-same-server). |
| `MINDER_FORCE_QUICK_CHECK` | `1` | Force the SQLite integrity check to run on DB open even after a clean shutdown. Diagnostic escape hatch — see [Database corruption after hard stop](#database-corruption-after-hard-stop). |
| `MINDER_QUICK_CHECK_MAX_BYTES` | bytes | Size below which the integrity check always runs regardless of a clean shutdown. Defaults to 268435456 (256 MB). Lower it to allow the fast path on a smaller index; raise it to keep checking a large one. |
| `MINDER_PARSE_CACHE_MB` | megabytes | Memory budget for the session-parse cache, in **source** megabytes. Defaults to 1024 (1 GiB), which retains roughly 2 GiB of heap — parsed transcripts measure about 2× their source size. Raise it on a machine with headroom: a larger budget is strictly better for the full-corpus sweep, up to what the process can afford. Above the budget the largest transcripts are evicted first, so they are re-parsed each sweep while the long tail stays warm. |

**Note:** there is no `MINDER_PORT` override. The service templates pin `PORT=4100` at install time, and the repo's `dev`/`start` scripts hardcode `-p 4100`. The standalone `server.js` itself honors `PORT`/`HOSTNAME` environment variables when run by hand, but the installed service always uses 4100.

## Standalone Server Package

Task C0 builds a self-contained `dist/minder-server/` directory that can run on any machine with Node installed, without needing the full project source:

```bash
pnpm build && pnpm package:standalone
```

The package contains:
- Compiled Next.js application
- All necessary dependencies (via `node_modules/`)
- Service scripts

The service scripts prefer the standalone package (lower overhead) but fall back to `next start` if the package is not found.

## Health Check Endpoint

The `/api/health` endpoint is a lightweight liveness + readiness probe designed for the tray app (and monitoring systems) to poll periodically. It completes in under 100ms with no network calls or subprocess spawning.

**Request:**
```
GET /api/health
```

**Response (HTTP 200 or 503):**
```json
{
  "ok": true,
  "status": "ok",
  "version": "1.2.0",
  "uptimeSec": 3600,
  "demoMode": false,
  "db": {
    "state": "success",
    "attempts": 1,
    "quarantineRuns": 0,
    "failedAt": null,
    "lastError": null
  },
  "bootstrap": {
    "ran": true,
    "subsystems": ["gitStatusCache", "githubActivityCache", "manualStepsWatcher"]
  },
  "watchers": {
    "gitStatus": 5,
    "githubActivity": 3,
    "manualSteps": 2,
    "dispatcher": true,
    "disposers": 8
  }
}
```

- `ok` — true only when the database is initialized and ready
- `status` — `"ok"` (ready) or `"degraded"` (running but some subsystems have warnings)
- `version` — application version from `package.json`
- `uptimeSec` — seconds since the server started
- `demoMode` — whether demo-mode synthetic data is active
- `db` — database initialization state (`idle`, `in-flight`, `success`, `transient-failed`, or `permanent-failed`)
- `bootstrap` — boot-time scan status: whether it ran and which subsystems it started
- `watchers` — counts of active background watchers (git dirty status, GitHub activity, manual steps, task dispatcher, shutdown disposers)

## Service-Mode Logging

In service mode, structured logs are written to a rotating file at `~/.minder/logs/minder.log` (in addition to console output). Each log line is JSON-formatted with fields: `ts` (ISO timestamp), `level`, `subsystem`, `msg`, and any additional context.

- **Rotation:** When the log file reaches 5 MB, it rotates (up to 3 backups: `minder.log.1`, `.log.2`, `.log.3`).
- **Levels:** `info`, `warn`, `error`.
- **Subsystems:** `bootstrap`, `lifecycle`, `git`, `github`, `mcp`, `scan`, etc.

## Graceful Shutdown

The server listens for shutdown signals (`SIGTERM`, `SIGINT`, Windows `SIGBREAK`) and disposes resources in the correct order:

1. **Watchers:** Git status cache, GitHub activity cache, manual steps watcher, MCP config watcher, and task dispatcher stop accepting new work.
2. **In-flight work:** Any task or scan already in progress is allowed to complete (with a configurable timeout).
3. **Database checkpoint:** Both SQLite files (index.db and tasks.db) are checkpointed and closed last, after all producers have stopped.

This ensures data is never corrupted by an abrupt exit.

## Port Collision

If a `pnpm dev` server is already running, `pnpm service:start` will fail to bind to port 4100. The remedy is to stop the dev server first:

```bash
pnpm service:stop      # stop the service
# OR
pkill -f "next dev"    # kill the dev server
```

Once the port is free, the service can start.

## Troubleshooting

### Service won't start (Windows)

- Verify registration: `schtasks /query /tn MinderDashboard`
- Check for port conflicts: `netstat -ano | findstr :4100`
- Look for error logs: `~/.minder/logs/minder.log` or Event Viewer (Windows Logs → Application → Application Error)

### Service won't start (macOS/Linux)

- Verify registration: `systemctl --user status minder` (Linux) or `launchctl list | grep minder` (macOS)
- Check for port conflicts: `lsof -i :4100`
- Look at logs: `~/.minder/logs/minder.log` or `journalctl --user -u minder` (Linux)

### PATH not found errors

If commands like `git`, `gh`, or `node` are not found in log files, it usually means `PATH` changed after install. Re-run `pnpm service:install` to capture the current shell's `PATH`.

### Database corruption after hard stop

If `~/.minder/index.db` becomes corrupted after a hard kill, delete it — it will be rebuilt from your project files on the next startup. Session data lives separately in `~/.claude/projects/`, so no work is lost.

**How the integrity check is scheduled.** Opening the index runs `PRAGMA quick_check`, and that scan scales with the file's size — on a multi-gigabyte index read cold after a reboot it can take minutes. Because the SQLite driver is synchronous, the whole server is unresponsive for that entire window (including `/api/health`, which is what made the tray app report a still-booting server as an unresponsive foreign process).

So the check is now skipped when **all** of these hold:

- the previous shutdown was graceful, recorded in an `index.db.clean` marker written only after the WAL was confirmed drained;
- the DB file's size and mtime still match what that marker recorded — any write since invalidates it;
- the `-wal` sidecar is absent or empty, which is independent evidence the graceful path completed;
- the index is at least 256 MB. Below that the scan is milliseconds, so it always runs.

Anything short of that proof runs the full check, which means a reboot, a force-kill, or a power loss still gets verified. Set `MINDER_FORCE_QUICK_CHECK=1` to force it regardless. The `db: probed` line in `~/.minder/logs/minder.log` records how long the open actually took in its `ms` field.
