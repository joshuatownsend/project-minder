# OpenTelemetry (OTEL)

Project Minder can receive real-time telemetry events from Claude Code via the
OpenTelemetry Protocol (OTLP). When enabled, Claude Code streams tool events,
API calls, and cost metrics directly to Project Minder's local ingest endpoint.

## What OTEL unlocks

- **Edit acceptance tracking** — see per-tool accept/reject rates for write
  operations (Edit, Write, MultiEdit) across your sessions (coming in a future
  update).
- **Tool latency** — p50/p95/max latency per tool, so you can see which tools
  are slow (coming in a future update).
- **Cost metrics stream** — structured per-session token and cost data directly
  from Claude Code's billing pipeline, not recomputed from JSONL.

## Setup

1. Open **Settings → Integrations → OpenTelemetry**.
2. Leave the endpoint as the default (`http://localhost:4100/api/otel`) unless
   Project Minder runs behind a reverse proxy.
3. Click **Install**. Project Minder writes four environment variables into
   `~/.claude/settings.json`:

   | Variable | Value |
   |---|---|
   | `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` |
   | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4100/api/otel` (or your custom endpoint) |
   | `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` |
   | `OTEL_LOG_TOOL_DETAILS` | `1` |

4. **Restart Claude Code** for the env vars to take effect. Claude Code reads
   `settings.json` at startup.

## Disabling

Click **Remove** in Settings → Integrations → OpenTelemetry. Project Minder
removes the four env vars from `~/.claude/settings.json` and leaves all other
configuration untouched. Restart Claude Code to stop the telemetry stream.

## Privacy

All telemetry data stays local. The OTLP endpoint is only reachable inside
your machine (default `localhost:4100`). No data is sent to Anthropic or any
third party by Project Minder. Claude Code itself may send telemetry to
Anthropic independent of this configuration — see Anthropic's privacy policy
for details.

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
