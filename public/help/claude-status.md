# Claude Status Alerts

Project Minder polls [status.claude.com](https://status.claude.com) and surfaces active Claude incidents inside the dashboard so you know whether an API failure you're debugging is local or upstream.

## Where It Appears

- **Sticky banner** — A colored banner appears below the topbar on every route whenever any Claude service is in `degraded_performance`, `partial_outage`, or `major_outage`, or whenever an active incident exists on the public status page. The banner stays visible until the underlying state clears.
- **Toast notifications** — When a new incident appears, when an incident's status changes (e.g. `investigating` → `monitoring`), or when an incident resolves, you get a short toast.

## Banner Colors

| Color | Meaning |
|---|---|
| **Amber** (`degraded`) | One or more components are reporting `degraded_performance`, **or** there's an active incident with `minor` impact |
| **Red** (`incident`) | An active incident has `critical` impact, **or** any component is in `major_outage` |
| (hidden) | All components operational and no active incidents |

Click "View incident" on the banner to open the incident page on status.claude.com in a new tab.

## How It Works

Project Minder calls Statuspage's public JSON summary API every 60 seconds while the dashboard is open. There's no background polling when no browser tab is open — the server-side cache is request-driven.

- **Source URL**: `https://status.claude.com/api/v2/summary.json` (no auth, no rate limits, CORS-enabled)
- **Cache**: `process.cwd()/.cache/claude-status.json` (30-second memory TTL, 30-minute stale tolerance)
- **Failure mode**: If the upstream fetch fails, the banner keeps showing the last good snapshot with a subtle "Last checked Xm ago" footnote and retries with exponential backoff (60s → 8m cap).

## Disabling the Feature

Settings → Active Features → **Claude status alerts** toggles the entire feature. With the flag off:

- `/api/claude-status` returns `{"disabled": true}`.
- The banner is hidden everywhere.
- No upstream polling happens.
- The MCP tool `get-claude-status` returns `{"disabled": true}` to MCP clients.

## MCP Access

A Claude agent connected to the Project Minder MCP server can call `get-claude-status` to self-diagnose whether an API issue is upstream:

```
mcp__project-minder__get-claude-status
  inputs: { includeOperationalComponents?: boolean }
```

Returns the same snapshot the banner reads from, plus a `source` field (`live` / `disk-cache` / `stale` / `empty`) so the agent knows how fresh the data is.

## Privacy

Only outbound calls go to `status.claude.com`. No telemetry about your usage is sent. The disk cache contains nothing but the raw Statuspage payload.
