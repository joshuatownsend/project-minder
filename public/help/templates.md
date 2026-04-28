# Templates

Templates package a curated set of Claude Code config — agents, skills, slash commands, hooks, and MCP servers — so you can apply that bundle to other projects (or new projects) with a single click.

## Two flavors

- **Live** — the template is just a pointer to a source project plus a list of selected units. Edits to the source project flow through. Best while the template is still evolving.
- **Snapshot** — a frozen copy of the selected units, stored at `<devRoot>/.minder/templates/<slug>/bundle/`. Edits to the original project don't affect the snapshot. Best when you've stabilized the template and want it pinned.

You can convert a live template to a snapshot from the template detail page; the reverse direction isn't supported (snapshots are deliberately immutable bundles).

## Disk layout

```
<devRoot>/.minder/templates/<slug>/
  template.json            # manifest (schemaVersion 1)
  bundle/                  # only present for snapshots
    .claude/
      agents/<slug>.md
      skills/<slug>.md       # standalone
      skills/<slug>/SKILL.md # bundled
      commands/<slug>.md
      settings.json          # contains only the selected hooks
      hooks/<file>           # referenced shell scripts
    .mcp.json                # contains only the selected MCP servers
```

Snapshot bundles mirror a real project's `.claude/` layout — the apply layer treats either flavor as a "virtual project root" and reuses the same scanners (`scanClaudeHooks`, `walkProjectAgents`, etc.). One code path, one set of invariants, two sources of truth.

## Creating a template

From any project card on the dashboard, open the three-dot menu and choose **Mark as template…**. The modal:

1. **Slug + name + optional description** — slug is lowercase alphanumeric/dash, ≤ 64 chars.
2. **Unit picker** — every project-local agent, skill, hook, and MCP server with a checkbox. Use **all** / **none** for bulk toggles.
3. **Create template** — POSTs the manifest to `/api/templates`. Default kind is `live` — the source project's `.claude/` is referenced, not copied.

You're then redirected to the template's detail page where you can apply it, save it as a snapshot, or delete it.

## Applying a template

From the template detail page, click **apply…** to open the apply modal:

- **Target**:
  - **Existing project** — pick one from the dropdown (the live source is excluded).
  - **New project** — Project Minder will `mkdir <devRoot>/<relPath>` and run `git init` (no remote, no first commit, no language scaffolding). The directory must not already exist.
- **Default conflict policy** — `skip` / `overwrite` / `merge` / `rename`. Per-unit override planned for a follow-up. Hook and MCP units reject `rename` and surface the error in the per-unit result list — pick a policy each unit kind accepts.
- **Preview** runs `dryRun: true` and shows the diff for every unit before any writes.
- **Apply** writes atomically. The result block lists each unit's outcome: `applied` / `merged` / `skipped` / `error` along with any warnings (e.g., `local-scope source promoted to project-shared`, `2 env values to fill in`).

## Invariants that carry over from V1

Every safety property of the single-unit apply layer applies to template apply too:

- **Path safety** — every target path (existing or freshly bootstrapped) is resolved into one of the configured dev roots; `<root>/.minder/` is reserved.
- **Hook idempotency** — `event + matcher + sha256(invocation)` keys mean re-applying a template never duplicates hooks.
- **`local`-scope promotion** — hooks sourced from `settings.local.json` write to project-shared `settings.json` at the target with a warning.
- **MCP env-keys-only** — env values are never copied. The target's `.mcp.json` receives empty-string placeholders for every env key.
- **Hook script copy** — referenced scripts at `.claude/hooks/<file>` come along automatically; absolute paths into the source project are rejected.

## API reference

- `GET  /api/templates` — list manifests + per-slug parse errors.
- `POST /api/templates` — create a live template. Body: `{ slug, name, description?, sourceSlug, units }`.
- `GET  /api/templates/[slug]` — read a manifest.
- `PATCH /api/templates/[slug]` — `{ action: "snapshot" }` converts a live template to a snapshot.
- `DELETE /api/templates/[slug]` — removes the template directory (manifest + bundle if any).
- `POST /api/templates/[slug]/apply` — apply the template. Body: `{ target, conflictDefault, perUnitConflict?, dryRun? }`.
