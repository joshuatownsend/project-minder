import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getEditAcceptance,
  getToolLatency,
  getTokenUsage,
  getCacheEfficiency,
  getHookActivity,
  getPressureSnapshot,
  queryOtelEvents,
  queryOtelMetrics,
  periodToMs,
} from "@/lib/db/otelQueries";
import { SessionIdSchema, OtelPeriodSchema } from "../schemas";
import { jsonResult } from "../result";

export function registerOtelTools(server: McpServer): void {
  server.registerTool(
    "query-otel-events",
    {
      title: "Query raw OTEL events",
      description:
        "Returns rows from `otel_events` filtered by event name (e.g. 'tool_result', " +
        "'api_request', 'compaction', 'hook_execution_complete'), session, and time window. " +
        "Each row includes the full JSON payload. Useful for ad-hoc investigation.",
      inputSchema: {
        eventName: z
          .string()
          .optional()
          .describe(
            "OTEL event name: tool_decision | tool_result | api_request | api_error | " +
              "api_retries_exhausted | hook_execution_complete | compaction"
          ),
        sessionId: SessionIdSchema.optional(),
        period: OtelPeriodSchema,
        limit: z.number().int().min(1).max(1000).default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ eventName, sessionId, period, limit }) => {
      const events = await queryOtelEvents({
        eventName,
        sessionId,
        since: periodToMs(period),
        limit,
      });
      return jsonResult({ period, total: events.length, events });
    }
  );

  server.registerTool(
    "query-otel-metrics",
    {
      title: "Query raw OTEL metrics",
      description:
        "Returns rows from `otel_metrics` filtered by metric name (e.g. " +
        "'claude_code.token.usage', 'claude_code.cost.usage', 'claude_code.session.count'), " +
        "session, and time window. Useful for plotting custom token/cost time series.",
      inputSchema: {
        metricName: z.string().optional(),
        sessionId: SessionIdSchema.optional(),
        period: OtelPeriodSchema,
        limit: z.number().int().min(1).max(1000).default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ metricName, sessionId, period, limit }) => {
      const metrics = await queryOtelMetrics({
        metricName,
        sessionId,
        since: periodToMs(period),
        limit,
      });
      return jsonResult({ period, total: metrics.length, metrics });
    }
  );

  server.registerTool(
    "get-tool-latency",
    {
      title: "Tool latency percentiles",
      description:
        "Returns P50, P95, max latency and error rate per tool, derived from `tool_result` " +
        "OTEL events. Optional sessionId filters to one session.",
      inputSchema: {
        period: OtelPeriodSchema,
        sessionId: SessionIdSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period, sessionId }) => {
      const result = await getToolLatency({
        since: periodToMs(period),
        sessionId,
      });
      return jsonResult({ period, ...result });
    }
  );

  server.registerTool(
    "get-edit-acceptance",
    {
      title: "Tool edit-acceptance rates",
      description:
        "Returns per-tool acceptance/rejection counts and rate from `tool_decision` events. " +
        "Useful for measuring how often Claude's proposed Edit/Write operations are accepted.",
      inputSchema: {
        period: OtelPeriodSchema,
        sessionId: SessionIdSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period, sessionId }) => {
      const result = await getEditAcceptance({
        since: periodToMs(period),
        sessionId,
      });
      return jsonResult({ period, ...result });
    }
  );

  server.registerTool(
    "get-token-usage-telemetry",
    {
      title: "Daily token usage from OTEL metrics",
      description:
        "Returns a daily time series of input/output/cache-read/cache-creation tokens, " +
        "derived directly from `claude_code.token.usage` metrics — distinct from the " +
        "session-derived `get-usage` tool which sums from indexed turns.",
      inputSchema: { period: OtelPeriodSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period }) => jsonResult({ period, ...(await getTokenUsage({ period })) })
  );

  server.registerTool(
    "get-cache-efficiency",
    {
      title: "Prompt-cache efficiency trend",
      description:
        "Returns the daily cache-hit rate (cacheRead / totalFlow) and overall hit rate across " +
        "the period. High values indicate prompt caching is working well; low values point at " +
        "missed cache opportunities.",
      inputSchema: { period: OtelPeriodSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period }) =>
      jsonResult({ period, ...(await getCacheEfficiency({ period })) })
  );

  server.registerTool(
    "get-hook-activity",
    {
      title: "Hook invocation activity",
      description:
        "Returns per-hook fire counts and duration percentiles (P50/P95) from " +
        "`hook_execution_complete` events.",
      inputSchema: { period: OtelPeriodSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period }) =>
      jsonResult({
        period,
        ...(await getHookActivity({ since: periodToMs(period) })),
      })
  );

  server.registerTool(
    "get-context-pressure",
    {
      title: "API errors, compaction, retry-exhaustion counts",
      description:
        "Returns counts of `api_error`, `compaction`, and `api_retries_exhausted` events in the " +
        "period, plus the most recent error details. Helpful for surfacing whether Claude Code " +
        "is hitting context-pressure or retry-storm conditions.",
      inputSchema: { period: OtelPeriodSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period }) =>
      jsonResult({
        period,
        ...(await getPressureSnapshot({ since: periodToMs(period) })),
      })
  );
}

