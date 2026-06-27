# Manual Steps Tracker

The Manual Steps Tracker surfaces action items that Claude identifies during coding sessions — things like database migrations, environment variable setup, external service configuration, and CLI commands you need to run manually.

## How It Works

When Claude Code identifies a step you need to perform manually, it records an entry in `MANUAL_STEPS.md` in your project root — a living checklist of the actions still outstanding. Project Minder automatically detects these files and displays them in the dashboard.

## Where to Find Manual Steps

- **Project Cards**: A pending count badge appears on cards for projects with outstanding steps.
- **Project Detail Page**: Click into a project and select the "Manual Steps" tab to see all entries with interactive checkboxes.
- **Cross-Project Dashboard**: Click "Manual Steps" in the navigation bar to see all pending steps across every project.

## Checking Off Steps

Click any step checkbox to mark it complete. This directly updates the `MANUAL_STEPS.md` file on disk, changing `- [ ]` to `- [x]`. You can also uncheck a step to mark it pending again.

## Archiving Completed Steps

`MANUAL_STEPS.md` is a living checklist, not an append-only log. When an entire entry is done or made obsolete by a newer plan, Claude moves it out of `MANUAL_STEPS.md` into a companion **`MANUAL_STEPS.archive.md`** (with a `> archived YYYY-MM-DD — why` note) so the active list — and the dashboard's pending counts — show only what's still outstanding. The archive file is committed to git for the historical record, but Project Minder's scanners ignore `*.archive.md`, so archived work never inflates your active counts.

You can still review archived items any time: open a project's **Manual Steps** (or **TODOs**) tab and expand the **Archived** disclosure at the bottom. It loads the archive on demand and is read-only.

## Real-Time Notifications

When Claude adds new manual steps to any project, Project Minder will:
- Show an in-app toast notification
- Send an OS-level notification (if permitted)
- Play a short notification sound

## Entry Format

Each entry in `MANUAL_STEPS.md` follows this format:

```
## 2026-03-17 14:32 | feature-slug | Plain English Title

- [ ] Step description
  Indented detail lines with context
  `example commands`
  See: https://docs.example.com

---
```

## Worktree Steps

When working in a Claude Code worktree, manual steps created there are surfaced on the parent project's Manual Steps tab in a collapsible section labeled with the branch name. Worktree steps are **read-only** — they cannot be toggled from the dashboard. They disappear when the worktree is merged and removed.

## Filtering & Sorting

On the cross-project dashboard you can:
- **Filter**: Show all steps or only pending ones
- **Sort**: By most recent or by most pending steps
