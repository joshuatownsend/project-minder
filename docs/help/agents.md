# Agents

The Agents page shows every Claude Code agent available to you — from your personal `~/.claude/agents/` folder, installed plugins, and any project-specific agents — alongside how often each has been invoked.

## What Is an Agent?

An agent is a named persona defined in a Markdown file with YAML frontmatter. It can have a specific model, a restricted toolset, and a system-style description. Agents are invoked via the `Agent` tool (with a `subagent_type` argument) inside Claude Code sessions.

## Sources

- **User** — agents in `~/.claude/agents/` (and category subdirectories like `engineering/`, `marketing/`)
- **Plugin** — agents shipped with installed plugins (e.g., `feature-dev:code-reviewer`)
- **Project** — agents in `<project>/.claude/agents/` scoped to a specific project

## Cross-Project Browser (`/agents`)

- **Search** — filters by name, description, category, and plugin name
- **Source filter** — narrow to user / plugin / project agents
- **Sort** — by most invoked, recently used, or name A–Z
- **Expand row** — shows tools, body excerpt, recent session links, and a "View full body" toggle

## Per-Project Agents Tab

On each project's detail page, the **Agents** tab shows:

- **Available (project-local)** — agents defined in the project's `.claude/agents/` folder
- **Invoked here** — any agent used in this project's sessions, sorted by invocation count

## Usage Statistics

Invocation counts come from session history (`~/.claude/projects/`). The `Agent` tool call's `subagent_type` argument is matched against the catalog. Plugin-namespaced invocations (e.g., `feature-dev:code-architect`) that don't match a catalog entry appear as **Plugin (uncategorized)** rows.
