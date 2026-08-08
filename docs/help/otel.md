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
| **Token Usage** | Daily input, output, cache-read, and cache-creation totals as stacked mini-bars. | `claude_code.token.usage` metrics |
| **Cache Efficiency** | Large hit-rate percentage with a daily sparkline and a dashed 70% target line. Hit rate = cacheRead ÷ (input + output + cacheCreation). | `claude_code.token.usage` metrics |
| **Hook Activity** | Fire counts per hook with proportional bars, plus p50 / p95 execution durations, and a badge naming the data source. | `hook_execution_complete` events |
| **Pressure** | API error count, retry-exhaustion count, and context-compaction count. Expands to a list of the 10 most recent errors with timestamp, retry attempt, and message preview. | `api_error`, `api_retries_exhausted`, `compaction` events |
| **Permission Denials** | Refused calls grouped by kind, with the top tools per kind and — where measurable — first-pass success for tasks that started on a denied turn. | `tool_uses.denial_kind` — **transcript ingest, not OTEL** |
| **Tool Provenance** | Proportional split of tool calls by stated source (built-in / MCP / plugin), with event and session counts. | `otel_events.tool_source` |

**Two cards here work without OTEL.** *Permission Denials* reads `denial_kind`
from the transcript-ingest tables, so it never needed telemetry at all — it sits
in this section because that is where the rest of the tool-call analytics live,
not because it shares their source. *Hook Activity* prefers OTEL but falls back
to decoding session transcripts, so it degrades rather than going dark (see the
source badge below). Every other card in the table has no non-OTEL source and
shows its empty state until telemetry is enabled.

### Choosing the window

One **today / 7d / 30d / all** toggle sits in the `Telemetry` section header and
governs every card beneath it. It defaults to 7 days.

Previously the cards disagreed by construction: Token Usage and Cache Efficiency
each carried their own toggle, while the other four were hard-wired to a 7-day
window with no control at all — so the grid could show two periods at once and
never said which was which.

### What the Hook Activity source badge means

Hook latency has two possible sources, and a row means something different in
each — so the card names the one it used:

- **OTEL** — rows are hook *names* (`PreToolUse:Bash`), from
  `hook_execution_complete` events. Only covers the period since you enabled
  telemetry.
- **transcript** — rows are the *commands* each hook ran (`codegraph sync`),
  decoded from session transcripts. Needs no setup and covers all history.

OTEL is preferred whenever any hook event exists. Because `since` is a lower
bound, **no choice of period falls back to the transcript source once OTEL has
data** — every window that ends at "now" includes recent events.

To read the transcript pipeline on a machine with telemetry enabled, ask for it
by name via the MCP tool:

```
get-hook-activity(period: "all", source: "transcript")
```

`source` accepts `auto` (the default preference order), `otel`, or
`transcript`. A forced source never falls through to the other one — an empty
result for the pipeline you named is the honest answer, where substituting the
other would return rows keyed on something else entirely. The card itself has no
source control yet; that is tracked in `TODO.md`.

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
- **"No denials recorded at all."** — deliberately *not* phrased as "all clear".
  Nothing ever refused and an index predating the `denial_kind` column are
  indistinguishable from here, and only one of them is good news.
- **"Nothing was refused in this window."** — a *different* state, and the one
  place this card can report good news plainly. Denials exist in the index, just
  none since the cutoff, so the absence is a real result rather than missing
  data. Widen the period to see earlier ones.
- **"No tool source recorded in this window."** — no event carries
  `tool_source`. That is a statement about instrumentation, not about your
  tools; an empty breakdown would read as "every tool was built-in", which is a
  different and unsupported claim.

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


## Correlating telemetry with transcripts

OTEL events and session transcripts describe the same work from two sides.
Minder joins them on the request id — `requestId` on assistant transcript
entries, `attrs.request_id` on OTEL events — which is promoted to a real column
on both tables so a lookup is an index probe rather than a scan of the whole
event table.

**Coverage is reported, not assumed.** Telemetry is opt-in and retained for a
window, so most historical turns have no matching event and never will. On the
reference machine about a third of assistant turns join. A correlation that
quietly dropped the unmatched ones would present a third of the data as all of
it, so the coverage ratio is returned alongside every correlated figure.

## Tool provenance

`tool_source` states whether a call was a built-in tool, an MCP tool, or a
plugin one. Minder otherwise infers this from the `mcp__server__tool` naming
convention — a convention rather than a guarantee, and one that says nothing
about plugin-provided tools. Where OTEL is available, the stated value is used.

A period where no event carries the attribute reports **no data** rather than an
empty breakdown: "OTEL cannot answer this" and "every tool was built-in" look
identical otherwise, and only one of them is a finding.

For the same reason the card lists **only the sources actually observed**. A
fixed built-in / MCP / plugin legend would imply plugin tools were measured and
found to be zero; on a machine where no plugin tool ever ran, the honest reading
is that none were seen.

### Coverage is stated, because the split is usually partial

The percentages are computed over calls that *state* a source, and Claude Code
began emitting `tool_source` partway through most indexes. On the reference
machine the attribute starts 2026-07-19 while events go back to 2023-11-14, so
a wide window covers only part of its calls:

| Window | Tool calls | Stating a source | Coverage |
|---|---|---|---|
| `today` | 5 | 5 | 100% |
| `7d` | 5,849 | 5,849 | 100% |
| `30d` | 27,866 | 20,392 | **73%** |
| `all` | 35,423 | 20,392 | **57%** |

The card therefore reads `20,392 of 27,866 tool calls state a source (73% of
this window)` rather than a bare total — otherwise a split describing 57% of
your history looks exactly like one describing all of it. Narrow the period for
a fully covered view. The percentage is truncated rather than rounded, so it can
never show `100%` beside a partial-window warning.

Both halves of that ratio are counted over the same event type, so coverage
cannot exceed 100%. If a future Claude Code release moves `tool_source` to a
different event, the card reports **no tool source recorded** until Minder
follows — a visible gap rather than a ratio quietly passing itself off as full
coverage.

Shown as the **Tool Provenance** card in `Stats → Telemetry`, and available
through the `get-tool-provenance` MCP tool.
