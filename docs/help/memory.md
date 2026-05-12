# Memory Browser

Project Minder ships three complementary memory views:

- **`/memory`** — cross-tier browser that lists every CLAUDE.md and auto-memory file across all scopes in one place. Edit any of them inline.
- **`/memory/seed`** — Day 1 seed generator. Proposes a starter set of memory files synthesized from your existing scan data so a new Claude Code install walks in already knowing your role, stack, and active projects.
- **`/memory/triage`** — auto-prune recommendations. Surfaces stale auto-memory files for review and offers Archive (reversible), Delete (30-day soft-delete), or Keep (suppress for N days). Never auto-deletes.
- **Project detail → Memory tab** — per-project view scoped to one project's auto-memory directory.

This page documents all four.

## Day 1 seed page `/memory/seed`

Generates five kinds of candidate memory files from data Project Minder already has:

- **`user_role.md`** — distilled from your global `~/.claude/CLAUDE.md`
- **`user_workstyle.md`** — your top session categories (Feature Dev, Refactoring, etc.) from JSONL replay
- **`reference_repos.md`** — every active scanned repo with a one-line stack summary
- **`reference_dev_environment.md`** — aggregate stack signals (frameworks, ORMs, styling) across your repos
- **`project_<slug>.md`** — per top-10 active project (sorted by last activity)

Each candidate carries `derived_from:` provenance in its frontmatter so a future audit can answer "where did this memory come from", and a `seeded: true` flag the main `/memory` browser surfaces.

### Anchor project

User-scope and reference candidates need a target dir. Pick an **anchor project** at the top of the page; user-scope seeds land in that project's `~/.claude/projects/<encoded>/memory/`. Per-project candidates auto-route to their own project's memory dir and don't need an anchor.

### Conflict resolution

If a candidate's filename already exists on disk, the row gets an `EXISTS` chip. Default action is **Skip**. To replace the existing file, click **Show 3-way diff** to compare existing vs proposed, then pick **Overwrite**. The diff renders line-by-line with `+` (proposed only), `−` (existing only), and unchanged lines.

You can also click **Edit before promote** to tweak the candidate body before writing.

### Typed authoring (the prefix↔type contract)

The writer enforces Claude Code's memory taxonomy: the basename prefix (`user_`, `feedback_`, `project_`, `reference_`) must match the `type:` field in the frontmatter, and a file with a `type:` declared but no typed prefix is rejected. This applies to the seed generator AND to direct edits through the memory editor — bad-shape memories never reach disk.

## Memory triage page `/memory/triage`

Combines the read-telemetry, age, broken-ref, and index-orphan signals into a single auto-prune view. The page never writes or deletes anything on its own — it **recommends** an action per row and waits for your click.

### Scoring

Triage operates strictly on auto-scope memory (files inside `~/.claude/projects/<encoded>/memory/`). User CLAUDE.md and per-project CLAUDE.md never appear here — they're authored by you, not the agent.

The moderate-profile defaults:

| Recommendation | When |
|---|---|
| **Archive candidate** | Never read **and** age > 60 days **or** last read more than 90 days ago |
| **Consider deletion** | Above **and** has broken refs, broken `@imports`, or is orphaned from `MEMORY.md` |
| **Keep** | Everything else |

Each row carries its reasons inline (`Never read`, `Last read 47d ago`, `1 broken ref`, `Not in MEMORY.md`).

### Actions

- **Archive** — move the file into `<memoryDir>/archive/<filename>`. Visible in the **Archived** section and restorable.
- **Delete…** — soft-delete into `<memoryDir>/.trash/<filename>`. A confirmation step appears first. Trashed files are permanently removed 30 days after their move; until then, they live in the **Trash** section with their auto-delete date and a **Restore** button.
- **Keep 7d / 30d / 90d** — suppress the row for the chosen window. The suppression map lives in `.minder.json` under `memoryTriage.suppressUntil`. Lift a hold from the **Suppressed** section.

### Collision handling

If you archive a file whose name already lives in `archive/`, the new copy gets a compact ISO timestamp suffix (e.g. `stale-20260512120241.md`) so the prior archive isn't clobbered. Same shape for trash and restore.

### Configuring thresholds

The moderate profile is the built-in default. Custom thresholds aren't user-tunable yet — file a TODO if you need a Strict (120d) or Aggressive (30d) variant.

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

### Memory budget banner

Above the scope filters, a **memory budget banner** aggregates index health and the total budget envelope across every scanned project:

- **Projects indexed** — count of projects that have a `MEMORY.md`
- **Entries** — total bullet-link entries parsed across all indexes
- **Max N/200 lines** — the largest index's line count, compared against Claude Code's documented 200-line cap. The number turns amber at ≥160 (80% of cap) and red at ≥190 (95% of cap), so a runaway index that risks truncation is visible at a glance
- **Total N KB (~M% of 32.0 KB)** — bytes-on-disk across every memory file (user CLAUDE.md, project CLAUDE.md, every auto-memory body). Compared informationally against the article's soft Hermes-style budget of 32 KB. No color tone on the aggregate — the alarm signal lives on the per-row chip
- **N large files** — count of memory files larger than 4 KB. Hover for the threshold
- **Orphans** — body files inside an auto-memory dir that aren't referenced by that project's `MEMORY.md`
- **Dangling links** — `MEMORY.md` entries whose target file doesn't exist on disk

Each auto-memory row carries an `indexed` flag (`true` if the project's `MEMORY.md` references the file, `false` if not). When a project's auto-memory dir has no `MEMORY.md`, rows in that dir leave the flag undefined — neutral state rather than "everything is orphaned".

### Per-row size chip

Rows for files larger than 4 KB show an inline size chip next to the display name (e.g. `5.2 KB`). The threshold matches Claude Code's "soft target per memory body" heuristic — most well-tuned memories stay well under it. Files below 4 KB show no chip so the row gutter stays quiet for the routine case.

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
