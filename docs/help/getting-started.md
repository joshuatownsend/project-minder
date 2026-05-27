# Getting Started

Project Minder is a local dashboard that automatically discovers all your projects in `C:\dev` and gives you a bird's-eye view of each one — tech stack, git status, dev servers, TODOs, and more.

## Opening the Dashboard

Start the app and visit **http://localhost:4100** in your browser. The dashboard loads automatically and scans your `C:\dev` directory for projects.

## What You'll See

The dashboard displays a grid of **project cards** — one for every folder it finds in `C:\dev`. Each card shows a quick summary:

- **Project name** and current status (Active, Paused, or Archived)
- **Tech stack** badges (framework, ORM, styling, database, etc.)
- **Git info** — current branch, last commit time, uncommitted changes
- **Dev server port** — the port the project runs on
- **Claude sessions** — when you last used Claude with this project
- **TODO progress** — how many TODO items are done vs. pending
- **Manual steps** — pending action items Claude identified for you

Click any card to open its **detail page** for the full picture.

## Manual Steps

When Claude Code identifies steps you need to perform manually (database migrations, env var setup, etc.), they appear in the **Manual Steps** nav link in the header. Click it to see all pending steps across every project with interactive checkboxes.

## Hiding Projects

If your `C:\dev` directory has projects you don't want on the dashboard, click the **three-dot menu** (⋮) on a project card and select **Hide project**. Hidden projects are excluded from future scans.

To manage hidden projects, click the **"(N hidden)"** link next to the project count. This opens a modal where you can unhide individual projects or all at once.

## Rescanning Projects

If you add or remove folders in `C:\dev`, click the **refresh button** (circular arrow icon) at the top of the dashboard. This forces a fresh scan and picks up any changes.

## Help Panel

Click the **?** icon in the top-right corner of the header to open the help panel. The panel automatically shows the help topic for the page you're on.

Inside the panel you can:

- Browse **all help topics** by clicking the back arrow
- **Open in a new tab** using the popout icon
- **Close** with the X button or press **Escape**

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Jump to the search box |
| `?` | Toggle the help panel |
| `Escape` | Close the help panel |

## Troubleshooting: "Local index database is unavailable"

If you see a red banner at the top of the Home page reading **"Local index database is unavailable"**, the local SQLite index at `~/.minder/index.db` has hit a terminal failure state after the recovery loop gave up.

This only fires after the recovery state machine has run two cumulative quarantine attempts and the rebuilt database still couldn't open — it is **not** the same thing as a momentary file lock. Routine startup contention (EBUSY, SQLITE_BUSY) is retried automatically with backoff and never reaches this banner.

**To recover:** stop the dev server (Ctrl-C in the terminal running `pnpm dev`) and start it again. The index rebuilds from the JSONL session files on startup; the failure state only clears on process exit by design.

The banner shows the last error code and a truncated message — useful when reporting the issue if a restart doesn't help.
