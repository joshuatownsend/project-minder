# Manual Steps Tracker

The Manual Steps Tracker surfaces action items that Claude identifies during coding sessions — things like database migrations, environment variable setup, external service configuration, and CLI commands you need to run manually.

## How It Works

When Claude Code identifies a step you need to perform manually, it appends an entry to `MANUAL_STEPS.md` in your project root. Project Minder automatically detects these files and displays them in the dashboard.

## Where to Find Manual Steps

- **Project Cards**: A pending count badge appears on cards for projects with outstanding steps.
- **Project Detail Page**: Click into a project and select the "Manual Steps" tab to see all entries with interactive checkboxes.
- **Cross-Project Dashboard**: Click "Manual Steps" in the navigation bar to see all pending steps across every project.

## Checking Off Steps

Click any step checkbox to mark it complete. This directly updates the `MANUAL_STEPS.md` file on disk, changing `- [ ]` to `- [x]`. You can also uncheck a step to mark it pending again.

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
