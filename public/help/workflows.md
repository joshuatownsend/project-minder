# Workflows

The Workflows page catalogs the multi-agent orchestration scripts Claude Code
runs through its `Workflow` tool.

**These are not GitHub Actions workflows.** A project's CI/CD panel uses the same
word for `.github/workflows/*.yml`; the two are unrelated and Minder keeps them
apart deliberately.

## Where they come from

Claude Code persists a workflow script every time one runs, under the session
that ran it:

```
~/.claude/projects/<project>/<session-id>/workflows/
    scripts/<name>-<runId>.js     the script, carrying its `meta` block
    wf_<runId>.json               the run record: runId, timestamp, taskId
```

That location is per **session**, so a workflow you use weekly has dozens of
near-identical copies on disk. The catalog folds them into one row per workflow,
which is what turns a directory listing into an answer to *"which workflows do I
actually use, and how often?"*

## What each row shows

- **Name, description and when-to-use** — read from the script's `export const meta`
- **Run count** and **last run**
- **Phases** the workflow declares, in order
- **Projects** it has run in
- An amber `!` when the `meta` block could not be fully read

A workflow whose `meta` cannot be parsed is still listed, under its filename. A
workflow that exists is more useful to show than to hide behind a parse error.

## Scripts are parsed, never executed

A workflow script is arbitrary JavaScript that spawns subagents — running one to
read its name would be absurd. Minder reads the `meta` object statically. That is
safe precisely because the Workflow tool requires `meta` to be a pure literal: no
variables, calls, spreads, or template interpolation.

The parse is deliberately conservative and fails soft. It is JavaScript rather
than frontmatter or JSON — bare identifier keys, single or double quotes,
trailing commas — so it cannot delegate to `JSON.parse`.

## Finding it

**Library → Workflows** in the sidebar, or the command palette. The page is also
at `/workflows` directly.

## Turning it off

The **Workflow catalog** feature flag (Settings → Feature flags, default ON)
disables the walk and empties the page.
