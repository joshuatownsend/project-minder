# WSL Integration

Project Minder can scan projects that live inside a WSL (Windows Subsystem for Linux) distro, using the `\\wsl.localhost\<distro>\...` network paths Windows exposes for each distro's filesystem.

## Adding a WSL scan root

The easy path: **Settings → Scan Roots → Detect WSL**. Minder enumerates your distros and, for running ones, finds `~/dev` directories you can add as scan roots with one click (then **Save & Rescan**). Stopped distros are listed with a hint — start the distro (open a WSL terminal) and detect again; Minder never starts one itself.

You can also type the path manually, e.g.:

```
\\wsl.localhost\Ubuntu-26.04\home\<user>\dev
```

The legacy `\\wsl$\<distro>\...` form works too. Each immediate subdirectory becomes a dashboard project, exactly like a native root (note: like every scan root, only directories containing a `.git` are picked up as projects).

## What a WSL root needs besides the root

A scan root alone only makes the *projects* appear. Two further settings decide whether any Claude data attaches to them:

| Setting | Without it |
|---|---|
| `claudeHomes` — the distro's `~/.claude` | Sessions recorded inside the distro are never read at all |
| `pathMappings` — `/home/<user>` ↔ `\\wsl.localhost\<distro>\home\<user>` | Linux-recorded paths can't be matched to the UNC-scanned project |

Both failures are **silent**: the projects scan and look healthy, and every session, cost, and insight attached to them reads as zero — indistinguishable from "I haven't worked there yet".

Minder now derives both from the root path whenever you save scan roots, including hand-typed ones, and never overwrites entries you set yourself. If you configured a WSL root before this existed, Settings shows a **"only half configured"** warning with a one-click **Link WSL Claude data** button.

The mapping is cut at the *user home*, not at the scan root, so one entry covers every repo under that home — including repos nested well below the root you added.

Two things to check if a WSL root shows no projects:

- **Depth.** Only *immediate* children are scanned. Pointing a root at a folder whose children are themselves containers (`printing-press/library/bamcli`) finds nothing — add the container that directly holds the repos (`…/printing-press/library`).
- **Same-named repos.** Checking out the same repository on both Windows and WSL is fine; both appear. The later root's copy takes a suffixed slug (`bamcli-library`) — see [Scan Roots](config.md#scan-roots).

## Discovery API

`GET /api/wsl` enumerates installed distros and, for **running** ones, probes `/home/<user>` for `dev` directories (scan-root candidates) and `.claude` homes. Utility distros (`docker-desktop*`) are excluded. Stopped distros are listed with their state but their filesystems are never touched.

## Stopped distros are never woken

Reading a `\\wsl.localhost\` path belonging to a **stopped** distro auto-starts that distro's VM (roughly 1–2 GB of RAM until WSL's idle shutdown). Minder deliberately never does this:

- Before each scan cycle touches a WSL root, it checks the distro's state via `wsl.exe -l -v` — a query that reports state without starting anything.
- If the distro is stopped, that root is **skipped for the cycle** and the dashboard keeps whatever was last scanned. Scanning resumes automatically on the first cycle after you start the distro (e.g. by opening a WSL terminal).
- Skipped roots surface in the top bar as a folder indicator with a count; the popover explains why each root was skipped (distro stopped, distro name not found, WSL unavailable, or plain unreadable path). Dismissing it lasts for the browser session.

The distro-state check is cached for 30 seconds, so scans over several WSL roots spawn `wsl.exe` once, not once per root.

## Git repositories over UNC

Git refuses to operate on repositories reached via `\\wsl.localhost\` paths by default (`fatal: detected dubious ownership`), because the files are owned by a different (Linux) user.

**This works out of the box as of 2026-07-21 — no configuration needed.** Minder passes `-c safe.directory=*` on its own read-only git calls, so WSL projects report branch, remote, dirty status and commit history the same as local ones.

> **Previously:** this page stated the check was something Minder "cannot and does not bypass", and WSL projects showed no git metadata at all. That was wrong — `-c` scopes the waiver to a single invocation, which is a narrower remedy than the global config change git's own error message recommends. The silent gap also blocked project grouping, since a checkout with no remote cannot be matched to its counterpart.

The waiver applies **only to Minder's own git reads**. Your global git config is untouched, so running `git status` yourself in a `\\wsl.localhost\` path still shows the ownership error. If you want it to work in your shell too, add the path to your global config on the Windows side (Git ≥ 2.46 supports the trailing `/*` glob):

```
git config --global --add safe.directory '%(prefix)///wsl.localhost/Ubuntu-26.04/home/<user>/dev/*'
```

Alternatively, run git operations from inside the distro, where ownership matches.

**What the waiver trades away.** `safe.directory` also guards against a repository whose `.git/config` names an executable (`core.pager`, `diff.external`, `core.fsmonitor`). Minder already runs these same commands against every directory in your configured scan roots, so this extends that existing exposure to UNC roots rather than creating a new kind of it — and scan roots are ones you added yourself.

## Claude sessions inside WSL

Sessions recorded by Claude Code running *inside* the distro live in the distro's own `~/.claude` and reference Linux paths (`/home/<user>/dev/...`), which don't match the UNC paths the scanner sees. Two Settings concepts bridge this, both under **Settings → Claude Homes**:

- **Extra Claude homes** — additional `.claude` directories to read session history from, e.g. `\\wsl.localhost\<distro>\home\<user>\.claude`.
- **Path mappings** — prefix rewrites (`/home/<user>` ↔ `\\wsl.localhost\<distro>\home\<user>`) applied when joining session data to scanned projects: history matching, session counts and live status, and the usage-slug that links a project to its cost/usage aggregates.

The easy path is **Detect WSL** in that section: it finds each running distro's `.claude` homes and one click adds the home *and* its implied path mapping. After **Save & Rescan**, WSL projects show their session counts, last-session previews, and live status exactly like native ones.

The same never-wake rule applies: a Claude home inside a stopped distro is skipped for the cycle and picked back up when the distro runs.
