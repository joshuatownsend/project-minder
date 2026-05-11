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

Each row shows the display name, owning project (where applicable), preview text, modification time, and a `STALE` badge when the file is over 30 days old, contains broken `@import` references, or names source files in its body that no longer exist on disk. Filter by scope or stale status with the chips above the list.

### Read telemetry

Each row also carries a `Read N× · <relative-time>` indicator when Claude Code has actually opened the file in a past session. The data comes from replaying every session JSONL under `~/.claude/projects/*/` and counting `Read({file_path})` tool calls whose target is a memory path. Lookup runs once per server lifetime (or after a 5-minute cache window) and is persisted to the SQLite index for cross-restart durability.

Only `Read` events are counted at the file level — `Grep` and `Glob` against memory directories target the directory, not a specific file, so they show up in the existing `/usage` analytics but aren't attributed per row here.

The **Unread (30d)** filter chip narrows the list to memories that Claude Code either has never opened (no record on file) or hasn't opened in the past 30 days. The 30-day cutoff matches the existing age-based staleness signal so both filters tell a consistent story.

### What counts as "stale"

Three signals can flip a row into the stale set, and hover the `STALE` chip to see which ones fired:

- **`N broken @imports`** — the body contains `@import ./relative.md` directives that don't resolve. This catches structured cross-file references whose targets were moved or deleted.
- **`N stale refs`** — the body mentions source-file paths (e.g. ``src/lib/foo.ts``, ``app/api/users/route.ts``, ``~/.claude/CLAUDE.md``) that don't exist on disk. Only paths with a `/` and a recognized extension (`ts`/`tsx`/`js`/`jsx`/`mjs`/`cjs`/`md`/`json`/`sql`/`yml`/`yaml`/`toml`/`sh`/`py`/`go`/`rs`) are scanned. Refs are resolved against the memory's parent project first, then against every other scanned project — first match wins. Triple-fenced code blocks and URLs are stripped before scanning so example code and `https://github.com/foo/bar.ts` don't false-positive.
- **`Nd old`** — the file's mtime is more than 30 days in the past.

### MEMORY.md index banner

When at least one project has a `MEMORY.md` file in its auto-memory dir, an **index banner** appears above the scope filters. It aggregates index health across every project:

- **Projects** — count of projects that have a `MEMORY.md`
- **Entries** — total bullet-link entries parsed across all indexes
- **Max N/200 lines** — the largest index's line count, compared against Claude Code's documented 200-line cap. The number turns amber at ≥160 (80% of cap) and red at ≥190 (95% of cap), so a runaway index that risks truncation is visible at a glance
- **Orphans** — body files inside an auto-memory dir that aren't referenced by that project's `MEMORY.md`. Often means a memory was written without updating the index
- **Dangling links** — `MEMORY.md` entries whose target file doesn't exist on disk. Often means a file was renamed or deleted without updating the index

Each auto-memory row also carries an `indexed` flag (`true` if the project's `MEMORY.md` references the file, `false` if not). When a project's auto-memory dir has no `MEMORY.md`, rows in that dir leave the flag undefined — neutral state rather than "everything is orphaned".

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
