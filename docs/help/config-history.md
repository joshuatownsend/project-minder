# Config History

Project Minder snapshots every file written by the **Templates** and **Config** apply layers before mutating it. The Config History tab on a project's detail page lists those snapshots and lets you roll back to any of them.

## What gets snapshotted

Every successful apply that writes a file:

- Agent / skill (standalone) / command `.md` files under `.claude/`
- Hook merges into `.claude/settings.json`
- MCP server changes to `.mcp.json`
- Settings-key edits to `.claude/settings.json`
- Plugin enable flips to `.claude/settings.json`
- GitHub workflow files under `.github/workflows/`

Bundled-skill applies write a directory tree and are intentionally skipped (directory snapshots are a separate retention concern). Dry-run applies never record a snapshot.

## Storage

Snapshots live under `~/.minder/config-history/<id>/<filename>` with one manifest line per snapshot in `~/.minder/config-history/manifest.jsonl`. The snapshot bytes are base64-encoded; manifest entries record the original target path, content SHA, label (which apply primitive triggered it), and project slug.

## Restore

The **Restore** button on each row writes the snapshot bytes back to the original target path. Two things are worth knowing:

- **Restore is recorded too.** A restore creates a new snapshot of the current target before overwriting it, so you can undo a restore.
- **No conflict detection.** If the target file has changed since the snapshot (because Claude Code or another tool edited it directly), Restore overwrites whatever's there. Check the file's mtime against the snapshot timestamp before restoring if you're unsure.

## Retention

Snapshots prune automatically using a smart-retention policy per file:

- **Within 24h** — every snapshot kept
- **24h to 7 days** — one snapshot per day
- **7 to 30 days** — one snapshot per week
- **Older than 30 days** — dropped

Pruning runs opportunistically when an apply records a new snapshot and the last prune was > 1 hour ago. Manual triggering isn't needed.

## Failure modes

A snapshot failure (disk full, permission denied) **never blocks an apply**. The apply proceeds and a warning is logged to the server console. The Config History tab simply doesn't gain the missing entry.
