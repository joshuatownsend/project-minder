# Setup Guide

Configure your projects so Claude Code generates the files Project Minder reads.

## What Project Minder Scans

Project Minder looks for three files in each project root:

- **TODO.md** — task checklist (pending/completed counts shown on cards)
- **MANUAL_STEPS.md** — developer steps Claude can't perform (tracked cross-project in the Steps dashboard)
- **INSIGHTS.md** — auto-generated from Claude session logs (no setup needed)

## Apply to a Project

At the bottom of the Setup page, the **Apply to a Project** panel lets you apply either or both steps directly to any project managed by Project Minder — no manual copy-paste needed. Pick a project, choose which steps to apply, and click Apply.

- Already-present blocks are detected and skipped (idempotent).
- Existing files (`CLAUDE.md`, `settings.local.json`) are backed up to `.minder-bak` before modification.

## Step 1: CLAUDE.md Instructions (required)

Add two instruction blocks to your project's `CLAUDE.md` — one for TODO.md and one for MANUAL_STEPS.md. Claude reads this file at the start of each session. These instructions tell Claude **when** to write to these files and **what format** to use.

This is sufficient for most projects.

## Step 2: Claude Code Hooks (optional)

Claude Code's `PreToolUse` hooks intercept every `Write` and `Edit` call. If Claude tries to write a malformed entry, the hook blocks the write before anything is saved to disk.

The hooks **complement** the CLAUDE.md instructions — they don't replace them. Without Step 1, Claude has no behavioral guidance and won't know to write to these files at all.

### Hook setup

1. Create `.claude/hooks/` directory
2. Add hook config to `.claude/settings.local.json`
3. Copy `validate-todo-format.mjs` to `.claude/hooks/`
4. Copy `validate-manual-steps.mjs` to `.claude/hooks/`

All scripts and config snippets are available with copy buttons on the Setup page.

## Format Reference

### TODO.md

```
- [ ] Pending task
- [x] Completed task
# Optional heading for grouping
```

The scanner only reads checkbox lines — headings and prose are ignored.

### MANUAL_STEPS.md

```
## 2026-04-16 14:30 | feature-slug | Description

- [ ] Step one
  Detail or command beneath the step
- [ ] Step two

---
```

Key rules:
- Header must match `## YYYY-MM-DD [HH:MM] | slug | title`
- All list items must use `- [ ]` or `- [x]` checkbox syntax
- Each entry must end with `---`
