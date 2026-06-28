# MCP Server

Project Minder ships an embedded **Model Context Protocol** server so Claude Desktop and Claude Code can ask questions about your local projects — token usage, OTEL telemetry, sessions, agents, skills, manual steps, insights, git status — directly from the conversation.

The MCP endpoint lives at `http://localhost:4100/api/mcp` and is served as a Streamable HTTP transport. Project Minder needs to be running for the endpoint to be reachable.

## Connecting Claude Code

Add an entry to `.mcp.json` in any project where you'd like Claude Code to have access:

```json
{
  "mcpServers": {
    "project-minder": {
      "type": "http",
      "url": "http://localhost:4100/api/mcp"
    }
  }
}
```

Restart Claude Code, then run `/mcp` to confirm the server appears. Try asking: *"How much have I spent on Claude this week?"* or *"What manual steps are still pending across my projects?"*

## Connecting Claude Desktop

Add the same block to your `claude_desktop_config.json`:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "project-minder": {
      "type": "http",
      "url": "http://localhost:4100/api/mcp"
    }
  }
}
```

Restart Claude Desktop and look for "project-minder" in the connection drawer.

## What it exposes

The server registers ~39 tools and ~12 resources covering every major Project Minder surface.

### Read tools — projects, usage, sessions

| Tool | Returns |
|---|---|
| `list-projects` | All scanned projects, filter by status/search |
| `get-project` | Full ProjectData for one slug |
| `get-usage` | UsageReport for a period (today / 7d / 30d / all) |
| `get-usage-by-day` | Just the daily breakdown |
| `get-usage-by-tool` | Tool / shell / MCP server call counts |
| `get-usage-by-category` | 13-category work breakdown |
| `get-one-shot-stats` | Retry-cycle / one-shot rates |
| `list-sessions` | SessionSummary list with filters |
| `get-session` | Full SessionDetail (timeline, file ops, subagents) |
| `search-sessions` | FTS search across titles and prompts |

### Read tools — agents, skills, manual steps, insights

| Tool | Returns |
|---|---|
| `list-agents` / `get-agent` | Agent catalog + invocation stats |
| `list-skills` / `get-skill` | Skill catalog + invocation stats |
| `get-agent-usage` / `get-skill-usage` | Cross-project invocation totals |
| `list-manual-steps` | Pending steps across all projects |
| `get-project-manual-steps` | Steps for one project |
| `list-insights` | Cross-project insight search |
| `get-project-insights` | Insights for one project |

### Read tools — OTEL telemetry

| Tool | Returns |
|---|---|
| `query-otel-events` | Raw event rows (tool_result, api_request, compaction, etc.) |
| `query-otel-metrics` | Raw metric rows (token usage, cost, session count, etc.) |
| `get-tool-latency` | Per-tool P50/P95/max + error rate |
| `get-edit-acceptance` | Per-tool Edit/Write acceptance rate |
| `get-cache-efficiency` | Daily prompt-cache hit-rate trend |
| `get-hook-activity` | Hook fire counts + duration percentiles |
| `get-context-pressure` | api_error / compaction / retry-exhaustion counts |
| `get-token-usage-telemetry` | Daily token series from OTEL metrics |

### Read tools — stats, git, dev servers

| Tool | Returns |
|---|---|
| `get-portfolio-stats` | Aggregated portfolio stats |
| `get-efficiency-grades` | Per-project A–F efficiency grades |
| `get-context-overhead` | Theoretical vs observed startup context |
| `get-project-hot-files` | Top-N most-edited files in one project |
| `get-project-error-propagation` | Per-tool/agent error stats |
| `get-project-file-coupling` | Files frequently edited together |
| `get-project-git-activity` | Per-branch commit/push activity |
| `get-git-status` | Cached dirty/clean status per project |
| `list-dev-servers` / `get-dev-server-output` | Managed dev-server state + recent stdout |

### Write tools — low-blast-radius mutations

| Tool | Effect |
|---|---|
| `scan-projects` | Invalidates the scan cache and re-walks devRoot(s) |
| `update-project-config` | Updates `.minder.json` status / hidden / port for one slug |
| `toggle-manual-step` | Toggles one MANUAL_STEPS.md checkbox in one project |
| `refresh-catalog` | Re-walks ~/.claude/agents and ~/.claude/skills |
| `refresh-git-status` | Forces a fresh git status check |

### Write tools — board (agent write-bridge)

These let a running Claude Code session push work into a project's canonical `BOARD.md` (and bridge it into the task dispatcher) without leaving the terminal. Each resolves the project by `slug`, writes the canonical board via the Phase 1 writer (atomic, file-locked), and returns the re-parsed board. Out-of-enum `status`/`priority` values are rejected at the JSON-RPC boundary; an unknown slug or a stale issue id surfaces as an `isError` result.

| Tool | Effect |
|---|---|
| `board_create_issue` | Adds an issue under an epic (`epicId`) or the Inbox; optional `status`/`priority`/`labels` and `sessionId`/`worktree` provenance |
| `board_log_finding` | Records an agent-discovered finding as a `(finding) …` Inbox row at status `triage` (with optional provenance) |
| `board_postpone` | Snoozes an issue by setting its status (defaults to `backlog`) |
| `board_promote_to_task` | Bridges an issue into a `~/.minder/tasks.db` task; the issue flips to `doing` on promote and back to `done` when the task completes. Returns `{ taskId, board }` |

### Resources

URI-addressable context blobs (attach as conversation context in Claude Desktop):

- `minder://config`
- `minder://stats`
- `minder://projects` (browsable)
- `minder://projects/{slug}` (+ sub-paths `/insights`, `/manual-steps`, `/sessions`)
- `minder://agents/{id}`, `minder://skills/{id}`
- `minder://sessions/{sessionId}`
- `minder://usage/{period}` (today / 7d / 30d / all)

## Security

The MCP server only listens on `localhost:4100`. The Streamable HTTP transport rejects requests whose `Host` or `Origin` headers don't match `localhost:4100` / `127.0.0.1:4100` — this is the DNS-rebinding-protection layer. Don't bind Next.js to `0.0.0.0` if you don't want the MCP endpoint reachable from your LAN; the host validation alone won't stop a peer who can spoof the Host header.

No authentication, no API keys: the endpoint exposes read access to your local Claude usage data and a handful of low-risk writes. Treat it like any other localhost dev service.

## Troubleshooting

**Tool list is empty in Claude Code** — confirm `pnpm dev` is running and `curl http://localhost:4100/api/mcp -X POST -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'` returns a 200 with a JSON-RPC body.

**DB-backed tools return empty** — Project Minder's SQLite index (`~/.minder/index.db`) is optional. Without it, the tools fall back to file-parse paths; OTEL tools return empty results until you ingest at least one event via the `/api/otel` endpoints.

**Write tool failed** — config and MANUAL_STEPS.md writes use atomic file-locked rename. If a write fails, the original file is untouched and the tool returns an isError result with the underlying message.
