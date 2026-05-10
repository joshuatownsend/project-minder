# Memory Browser

Project Minder ships two complementary memory views:

- **`/memory`** — cross-tier browser that lists every CLAUDE.md and auto-memory file across all scopes in one place. Edit any of them inline.
- **Project detail → Memory tab** — per-project view scoped to one project's auto-memory directory.

This page documents both.

## Cross-tier `/memory` page

The `/memory` page unifies three scopes:

- **User** — `~/.claude/CLAUDE.md`
- **Project** — `<project>/CLAUDE.md` for every scanned project
- **Auto-memory** — every `.md` file inside `~/.claude/projects/<encoded>/memory/` for every scanned project

Each row shows the display name, owning project (where applicable), preview text, modification time, and a `STALE` badge when the file is over 30 days old or contains broken `@import` references. Filter by scope or stale status with the chips above the list.

Click any row to open it in the right pane. **Edit** switches into a textarea; **Save** writes back atomically. The editor takes a snapshot via `~/.minder/config-history/` before every save so you can roll back from the Config History page. **Diff** compares your draft against the most recent snapshot.

If a file changes externally between the time you opened it and when you click Save, the editor surfaces a **File changed externally — Reload** banner instead of silently overwriting.

### Path-safety guarantees

The editor refuses to write to anything outside the allowlist (user CLAUDE.md, a scanned project's CLAUDE.md, or an `*.md` file directly inside an auto-memory directory). Attempts to PUT a fabricated id resolve to **400 PATH_NOT_ALLOWED**. The 2 MB content cap returns **413 TOO_LARGE**. mtime conflicts return **409 MTIME_CONFLICT**.

---

## Per-project Memory tab

The **Memory** tab on each project detail page lets you browse Claude Code's auto-memory files for that project without leaving Project Minder.

## What are memory files?

Claude Code (when configured with the auto-memory system prompt) writes persistent memory files to:

```
~/.claude/projects/<encoded-project-path>/memory/
```

These files capture things like:
- **user** — your role, expertise, and preferences
- **feedback** — corrections and validated approaches from past sessions
- **project** — ongoing work context, decisions, and deadlines
- **reference** — pointers to external systems (Linear, Grafana dashboards, etc.)

## Index (MEMORY.md)

`MEMORY.md` acts as a table of contents for all memory files. Project Minder renders it at the top of the Memory tab as the overview pane.

## File list

Below the index, all other `.md` memory files are listed in a panel on the left. Each row shows:

- A **type badge** (color-coded by category: blue=user, amber=feedback, green=project, gray=reference)
- The **file name**
- The **description** extracted from the file's YAML frontmatter
- When the file was **last modified**

## Viewer

Click any file in the list to load and render its full contents in the right panel. File contents are fetched on demand so the initial tab load is fast even for large memory directories.

## Editing

Each loaded file has an **Edit** button that switches the viewer into a textarea-based editor. Type your changes and click **Save** to write them back to disk. The dashboard validates the file name against path traversal and rejects anything other than `.md`. The PATCH endpoint backing the editor is `/api/memory/[slug]` with body `{ file, content }`.

## Stale warnings

Memory files that haven't been modified in **30 days** are marked with a small `STALE` badge in the file list. Stale memories are often a hint that a remembered fact has gone out of date — open the file and refresh, prune, or remove it.

## Memory file format

Memory files use YAML frontmatter:

```yaml
---
name: user role
description: One-line summary used when deciding relevance
type: user  # user | feedback | project | reference
---

Memory content goes here.
```

Project Minder reads the `type` and `description` fields to populate the badge and subtitle in the file list.
