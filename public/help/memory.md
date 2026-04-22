# Memory Browser

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
