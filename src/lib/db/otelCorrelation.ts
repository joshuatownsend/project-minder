import "server-only";
import { getDb, prepCached } from "./connection";

/**
 * C3 — joining OTEL telemetry to the transcript, and reading tool provenance
 * from OTEL rather than inferring it.
 *
 * **The plan named the wrong key.** C3 was specified against `message.uuid`,
 * said to have been added to OTel log events in 2.1.214. It does not appear in
 * this data under any spelling — a scan of every attribute key on 4,000
 * `tool_result` / `tool_decision` / `api_request` events turned up
 * `user.account_uuid` and `request_id`, and nothing else uuid-shaped.
 *
 * `request_id` is the key that actually works, and it was already on both
 * sides: Claude Code writes `requestId` on assistant transcript entries and
 * `attrs.request_id` on `api_request` events. Measured over the full local
 * corpus, **71,466 of 205,137** assistant turns (34.8%) match an OTEL event by
 * it, with all 39,139 `api_request` events carrying a distinct value. The
 * unmatched majority are turns from before OTEL was enabled — expected, and the
 * reason `coverage` is reported rather than assumed.
 */

export interface ToolProvenanceRow {
  /** `builtin` | `mcp` | `plugin` — stated by Claude Code, not inferred. */
  source: string;
  events: number;
  sessions: number;
}

export interface ToolProvenanceResult {
  sources: ToolProvenanceRow[];
  /** Events in the window that state a source — the denominator of the split. */
  total: number;
  /**
   * Tool calls in the window, whether or not they stated a source.
   *
   * The split is computed only over events carrying `tool_source`, so without
   * this the percentages describe an instrumented subset while looking like
   * they describe the window. `tool_source` shipped partway through most
   * indexes: on the reference machine the attribute starts 2026-07-19 while
   * events go back to 2023-11-14, so an `all` window states a source for 57.6%
   * of its calls and a `30d` window for 73.2%.
   */
  callsInWindow: number;
  /**
   * `total / callsInWindow`, or undefined when there is nothing to divide.
   *
   * Undefined rather than 1 for an empty window: "everything was measured" and
   * "there was nothing to measure" are different claims.
   */
  sourceCoverage?: number;
  /**
   * False when no event carries `tool_source`, i.e. OTEL is off or predates the
   * attribute. Distinct from "every tool was builtin", which is what a bare
   * empty list would look like.
   */
  hasData: boolean;
}

/**
 * The event that carries `tool_source`, and therefore the coverage denominator.
 *
 * Empirically the only one: across 200k+ events on the reference index the
 * attribute appears on `tool_decision` and nowhere else, and `tool_decision`
 * fires about once per tool call (35,423 against 35,189 `tool_result`), which
 * makes it a fair stand-in for "tool calls in the window". If Claude Code
 * starts emitting `tool_source` on another event type this must widen with it,
 * or coverage will read above 100%.
 */
const TOOL_SOURCE_EVENT = "tool_decision";

/**
 * Tool provenance straight from `tool_source`.
 *
 * This is the OTEL-side twin of A4: Minder otherwise infers whether a call was
 * an MCP call from the `mcp__server__tool` naming convention, which is a
 * convention rather than a guarantee and says nothing about plugin-provided
 * tools. `tool_source` states it.
 */
export async function getToolProvenance(opts: { since?: string } = {}): Promise<ToolProvenanceResult> {
  const db = await getDb();
  if (!db) return { sources: [], total: 0, callsInWindow: 0, hasData: false };

  const params = { since: opts.since ?? null };

  const rows = prepCached(
    db,
    `SELECT tool_source AS source,
            COUNT(*) AS events,
            COUNT(DISTINCT session_id) AS sessions
       FROM otel_events
      WHERE tool_source IS NOT NULL
        AND (@since IS NULL OR ts >= @since)
      GROUP BY 1
      ORDER BY events DESC`
  ).all(params) as ToolProvenanceRow[];

  // Counted independently rather than derived from the split, so coverage of 1
  // means every call stated a source — not that the query agreed with itself.
  const { calls } = prepCached(
    db,
    `SELECT COUNT(*) AS calls
       FROM otel_events
      WHERE event_name = @event
        AND (@since IS NULL OR ts >= @since)`
  ).get({ ...params, event: TOOL_SOURCE_EVENT }) as { calls: number };

  const total = rows.reduce((n, r) => n + r.events, 0);

  return {
    sources: rows,
    total,
    callsInWindow: calls,
    sourceCoverage: calls > 0 ? total / calls : undefined,
    hasData: rows.length > 0,
  };
}

export interface OtelTurnCorrelation {
  /** Assistant turns in range carrying a request id Minder can join on. */
  turnsWithRequestId: number;
  /** How many of those matched at least one OTEL event. */
  matched: number;
  /** `matched / turnsWithRequestId`, or undefined when there is nothing to divide. */
  coverage?: number;
  hasData: boolean;
}

/**
 * How much of the transcript OTEL can actually speak about.
 *
 * **Reported, never assumed.** The honest answer on the reference machine is
 * about a third: OTEL is opt-in and retained for a window, so most historical
 * turns have no telemetry and never will. A correlation that silently dropped
 * unmatched turns would present a third of the data as the whole of it — the
 * same class of error as an empty hook table reading like "no hooks
 * configured".
 *
 * Both sides are counted independently rather than inferred from one another,
 * so a coverage of 1 means every joinable turn matched, not that the query
 * matched itself.
 */
export async function getOtelTurnCoverage(opts: { since?: string } = {}): Promise<OtelTurnCorrelation> {
  const db = await getDb();
  if (!db) return { turnsWithRequestId: 0, matched: 0, hasData: false };

  const params = { since: opts.since ?? null };

  const total = prepCached(
    db,
    `SELECT COUNT(*) AS n
       FROM turns
      WHERE request_id IS NOT NULL
        AND (@since IS NULL OR ts >= @since)`
  ).get(params) as { n: number };

  // EXISTS rather than a JOIN: a turn can correspond to several OTEL events
  // (api_request, tool_result, …) and a plain join would count that turn once
  // per event, reporting coverage above 100%.
  const matched = prepCached(
    db,
    `SELECT COUNT(*) AS n
       FROM turns t
      WHERE t.request_id IS NOT NULL
        AND (@since IS NULL OR t.ts >= @since)
        AND EXISTS (
          SELECT 1 FROM otel_events e
           WHERE e.request_id = t.request_id
             AND (@since IS NULL OR e.ts >= @since)
        )`
  ).get(params) as { n: number };

  // `hasData` describes whether TELEMETRY exists to correlate against, not
  // whether the transcript has joinable turns. Basing it on the turn count made
  // a machine with OTEL switched off report `hasData: true, coverage: 0`, which
  // reads as "telemetry exists and covers nothing" rather than "there is no
  // telemetry" (Copilot review of #387).
  const otelPresent = prepCached(
    db,
    `SELECT 1 FROM otel_events
      WHERE request_id IS NOT NULL
        AND (@since IS NULL OR ts >= @since)
      LIMIT 1`
  ).get(params) as { 1: number } | undefined;

  const turnsWithRequestId = total?.n ?? 0;
  const matchedCount = matched?.n ?? 0;
  return {
    turnsWithRequestId,
    matched: matchedCount,
    coverage: turnsWithRequestId > 0 ? matchedCount / turnsWithRequestId : undefined,
    hasData: otelPresent !== undefined,
  };
}
