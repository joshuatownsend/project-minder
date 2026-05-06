# Plugins

The Plugins browser lists every Claude Code plugin installed via `~/.claude/installed_plugins.json`, enriched with usage counts from the agent/skill catalog and the SQLite index.

## Row anatomy

Each row shows:
- **Plugin name** — the plugin's identifier
- **Marketplace** — the registry the plugin came from (e.g. `anthropics/claude-plugins-official`)
- **Version** — the installed version, if known
- **Counts** — `Na · Ns · Nm` = agents · skills · MCP servers contributed by this plugin
- **Invocations** — total Agent + Skill tool calls attributed to this plugin across all sessions
- **Status badge** — `enabled`, `disabled`, or `blocked`

Expand a row to see links to the agents/skills/MCP servers contributed by this plugin, plus a link to the plugin's source repository.

## Status meanings

| Status | Meaning |
|---|---|
| **enabled** | Plugin is active and its agents/skills/hooks are loaded |
| **disabled** | Plugin is installed but not enabled in `~/.claude.json` |
| **blocked** | Plugin appears in `~/.claude/plugins/blocklist.json` |

## Invocation counts

Counts are computed by joining the catalog (which tracks which plugin contributed which agent/skill) with the session index's `tool_uses` table. Counts reflect only sessions that have been indexed — a freshly installed plugin with no sessions yet will show 0.

## Sorting

| Option | Effect |
|---|---|
| Name | Alphabetical by plugin name |
| Invocations | Most-used first |
