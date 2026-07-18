# WSL Integration

Project Minder can scan projects that live inside a WSL (Windows Subsystem for Linux) distro, using the `\\wsl.localhost\<distro>\...` network paths Windows exposes for each distro's filesystem.

## Adding a WSL scan root

Add the distro's dev directory as a scan root (Settings → Scan Roots), e.g.:

```
\\wsl.localhost\Ubuntu-26.04\home\<user>\dev
```

The legacy `\\wsl$\<distro>\...` form works too. Each immediate subdirectory becomes a dashboard project, exactly like a native root.

## Discovery API

`GET /api/wsl` enumerates installed distros and, for **running** ones, probes `/home/<user>` for `dev` directories (scan-root candidates) and `.claude` homes. Utility distros (`docker-desktop*`) are excluded. Stopped distros are listed with their state but their filesystems are never touched.

## Stopped distros are never woken

Reading a `\\wsl.localhost\` path belonging to a **stopped** distro auto-starts that distro's VM (roughly 1–2 GB of RAM until WSL's idle shutdown). Minder deliberately never does this:

- Before each scan cycle touches a WSL root, it checks the distro's state via `wsl.exe -l -v` — a query that reports state without starting anything.
- If the distro is stopped, that root is **skipped for the cycle** and the dashboard keeps whatever was last scanned. Scanning resumes automatically on the first cycle after you start the distro (e.g. by opening a WSL terminal).
- Skipped roots surface in the top bar as a folder indicator with a count; the popover explains why each root was skipped (distro stopped, distro name not found, WSL unavailable, or plain unreadable path). Dismissing it lasts for the browser session.

The distro-state check is cached for 30 seconds, so scans over several WSL roots spawn `wsl.exe` once, not once per root.

## Git repositories over UNC

Git refuses to operate on repositories reached via `\\wsl.localhost\` paths by default (`fatal: detected dubious ownership`), because the files are owned by a different (Linux) user. This is a Git safety feature that Minder cannot and does not bypass — affected projects simply show no git metadata (branch, dirty status, last commit) while everything else (package.json, TODO.md, ports, docs) works normally.

To opt in, add the path to your **global** git config on the Windows side (Git ≥ 2.46 supports the trailing `/*` glob):

```
git config --global --add safe.directory '%(prefix)///wsl.localhost/Ubuntu-26.04/home/<user>/dev/*'
```

Run any `git status` against one of the repos afterwards to confirm. Alternatively, run Git operations from inside the distro, where ownership matches.

## Claude sessions inside WSL

A distro's `~/.claude` (session history, usage data) is discovered by `GET /api/wsl` but not yet joined into the dashboard — sessions recorded inside WSL reference Linux paths (`/home/<user>/dev/...`) that don't match the UNC-scanned project paths. Cross-home session correlation is tracked as follow-up work.
