# OpenTelemetry (OTEL)

Project Minder can receive real-time telemetry events from Claude Code via the
OpenTelemetry Protocol (OTLP). When enabled, Claude Code streams tool events,
API calls, and cost metrics directly to Project Minder's local ingest endpoint.

## What OTEL unlocks

- **Edit acceptance tracking** — per-tool accept/reject rates for write
  operations (Edit, Write, MultiEdit), visible globally and per-session.
- **Tool latency** — p50/p95/max latency per tool, so you can see which tools
  are slow.
- **Token usage charts** — daily input/output/cache breakdown with today/7d/30d
  toggle, sourced directly from Claude Code's OTEL pipeline.
- **Cache efficiency** — hit-rate percentage with daily sparkline and a 70%
  target reference line.
- **Hook activity** — fire counts and p50/p95 execution durations per hook.
- **Pressure panel** — API error counts, retry exhaustion events, context
  compaction events, and a recent-errors list.
- **Cost metrics stream** — structured per-session token and cost data directly
  from Claude Code's billing pipeline, not recomputed from JSONL.

## Setup

1. Open **Settings → Integrations → OpenTelemetry**.
2. Leave the endpoint as the default (`http://localhost:4100/api/otel`) unless
   Project Minder runs behind a reverse proxy.
3. Click **Install**. Project Minder writes six environment variables into
   `~/.claude/settings.json`:

   | Variable | Value |
   |---|---|
   | `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` |
   | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4100/api/otel` (or your custom endpoint) |
   | `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` |
   | `OTEL_METRICS_EXPORTER` | `otlp` |
   | `OTEL_LOGS_EXPORTER` | `otlp` |
   | `OTEL_LOG_TOOL_DETAILS` | `1` |

4. **Restart Claude Code** for the env vars to take effect. Claude Code reads
   `settings.json` at startup.

## Disabling

Click **Remove** in Settings → Integrations → OpenTelemetry. Project Minder
removes the six env vars from `~/.claude/settings.json` and leaves all other
configuration untouched. Restart Claude Code to stop the telemetry stream.

## Privacy

All telemetry data stays local. The OTLP endpoint is only reachable inside
your machine (default `localhost:4100`). No data is sent to Anthropic or any
third party by Project Minder. Claude Code itself may send telemetry to
Anthropic independent of this configuration — see Anthropic's privacy policy
for details.

## What you'll see in the dashboard

Once OTEL is installed and Claude Code has been restarted, telemetry data
appears in two places:

### Stats page — Telemetry section

Navigate to **Stats → Telemetry** (or scroll to the bottom of `/stats`).

| Card | What it shows | Source events |
|---|---|---|
| **Edit Acceptance** | Per-tool accept/reject rates with color-coded progress bars (green ≥ 80%, amber ≥ 50%, red otherwise). SampleBadge turns amber when fewer than 10 decisions are recorded. | `tool_decision` events |
| **Tool Latency** | p50 / p95 / max latency table per tool. Rows turn red when p95 ≥ 10 s; a green dot appears when p50 < 500 ms. | `tool_result` events with `duration_ms` |
| **Token Usage** | Today / 7d / 30d toggle. Shows daily input, output, cache-read, and cache-creation totals as stacked mini-bars. | `claude_code.token.usage` metrics |
| **Cache Efficiency** | Large hit-rate percentage with a daily sparkline and a dashed 70% target line. Hit rate = cacheRead ÷ (input + output + cacheCreation). | `claude_code.token.usage` metrics |
| **Hook Activity** | Fire counts per hook with proportional bars, plus p50 / p95 execution durations. | `hook_execution_complete` events |
| **Pressure** | API error count, retry-exhaustion count, and context-compaction count. Expands to a list of the 10 most recent errors with timestamp, retry attempt, and message preview. | `api_error`, `retry_exhausted`, `context_compaction` events |

All cards default to the last 7 days. The window is not yet configurable in
the UI; use the `/api/telemetry/*` endpoints directly if you need a custom
range.

### Session detail — Tools tab

On any session detail page (`/sessions/[id]`), the **Tools** tab shows
**Edit Acceptance** and **Tool Latency** cards scoped to that specific
session, followed by the existing tool-usage bar chart. This lets you
compare acceptance rates and latency across sessions.

### Empty states

Each card shows an explanatory message when no data is available:

- **"No edit decisions recorded yet."** — either OTEL isn't installed, Claude
  Code hasn't been restarted, or no Edit/Write tools have been used yet.
- **"No latency data — install OTEL and restart Claude Code."** — same root
  cause, or the session predates OTEL installation.
- **"No hooks fired yet."** — no hooks are configured, or hooks haven't run
  in the selected time window.
- **"No pressure events in this period."** — no API errors, retries, or
  compactions occurred.

## Wire format

Project Minder's OTLP receiver accepts **HTTP JSON only**
(`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`). The default OTel SDK protocol is
protobuf; the `http/json` override is mandatory and is set automatically by
the installer.

Two endpoints are registered:

| Endpoint | Data |
|---|---|
| `POST /api/otel/v1/logs` | Tool events, API requests, session lifecycle |
| `POST /api/otel/v1/metrics` | Token usage, cost, session count |

Both implement the OTLP partial-success contract: a malformed individual
record is rejected without dropping the rest of the batch.

## Storage

Events land in the `otel_events` table in `~/.minder/index.db`. Metrics land
in `otel_metrics`. The schema uses a generic `payload_json` column for events
so detectors can be added in future waves without migrating existing rows.
