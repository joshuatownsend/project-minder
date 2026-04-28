# Agents

The Agents page shows every Claude Code agent available to you — from your personal `~/.claude/agents/` folder, installed plugins, and any project-specific agents — alongside how often each has been invoked, provenance details, and update status.

## What Is an Agent?

An agent is a named persona defined in a Markdown file with YAML frontmatter. It can have a specific model, a restricted toolset, and a system-style description. Agents are invoked via the `Agent` tool (with a `subagent_type` argument) inside Claude Code sessions.

## Sources

- **User** — agents in `~/.claude/agents/` (and category subdirectories like `engineering/`, `marketing/`)
- **Plugin** — agents shipped with installed plugins (e.g., `feature-dev:code-reviewer`)
- **Project** — agents in `<project>/.claude/agents/` scoped to a specific project

## Provenance Badges

Each row shows a badge indicating the agent's origin:

- **Marketplace badge** (e.g. `claude-plugins-official`) — agent is part of a plugin from that marketplace
- **"local"** — user-authored with no upstream
- **"project: slug"** — defined inside a project's `.claude/agents/` folder

An **amber dot** on the badge means an update is available upstream (currently supported for marketplace plugin agents only).

## Update Detection

Project Minder runs background update checks (24-hour TTL) for marketplace plugin agents. See the [Skills help page](/help/skills) for full details on how checks work.

## Cross-Project Browser (`/agents`)

- **Search** — filters by name, description, category, and plugin name
- **Source filter** — narrow to user / plugin / project agents
- **Updates filter** — show only agents with detected updates
- **Sort** — by most invoked, recently used, or name A–Z
- **Expand row** — shows tools, provenance details, action buttons, body excerpt, and recent session links

## Per-Row Actions (Expanded View)

Click any row to expand it and reveal:

- **Open source ↗** — opens the agent's GitHub repository in a new browser tab
- **Show in folder** — opens Explorer/Finder at the agent's install directory
- **Copy url / sha / path** — clipboard shortcuts
- **Re-check** — clears the update cache and re-queues a fresh check for all entries
- **↗ copy to project** — Template Mode action: copies this agent's `.md` file into another project's `.claude/agents/` folder. Pick a target, choose a conflict policy (`skip` / `overwrite` / `rename`), preview the diff, and apply. Plugin-source agents don't show this action (plugins manage themselves). See the [Config help page](/help/config) for full Template Mode behavior.

## Per-Project Agents Tab

On each project's detail page, the **Agents** tab shows:

- **Available (project-local)** — agents defined in the project's `.claude/agents/` folder
- **Invoked here** — any agent used in this project's sessions, sorted by invocation count

## Usage Statistics

Invocation counts come from session history (`~/.claude/projects/`). The `Agent` tool call's `subagent_type` argument is matched against the catalog. Plugin-namespaced invocations (e.g., `feature-dev:code-architect`) that don't match a catalog entry appear as **Plugin (uncategorized)** rows.
