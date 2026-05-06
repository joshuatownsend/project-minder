# Plans

The Plans browser surfaces every file in `~/.claude/plans/` as a searchable, filterable catalog. Plan files are the `.md` files Claude Code writes when you invoke plan mode.

## What you'll see

Each row shows:
- **Title** — extracted from the plan's front-matter `title:` field, or the first `# ` heading, or the filename.
- **Tags** — from the front-matter `tags:` array; use the tag dropdown to filter.
- **Modified** — relative timestamp for the file's last modification.
- **Related sessions** — sessions linked by UUID found anywhere in the plan body.

Expand a row to read the full plan body and click related-session chips to navigate directly to `/sessions/<id>`.

## Filtering and sorting

| Control | Effect |
|---|---|
| Search box | Filters by title, slug, or any tag (debounced 300ms) |
| Tag dropdown | Narrows to plans that include the selected tag |
| Sort | Modified (newest first) or Title (A–Z) |

## How plans are found

Project Minder scans `~/.claude/plans/*.md`. It does **not** recurse into subdirectories. Files with front-matter are parsed; files without are also shown (title falls back to the heading or filename).

## Related sessions

Session IDs are found by regex-matching UUIDs in the plan body. This is a heuristic — a UUID quoted in prose (e.g., from a log paste) may appear as a false positive. If you want precise control, add a `relatedSessions:` key to the plan's front-matter listing session IDs explicitly (the scanner prefers front-matter when present, planned for a future release).
