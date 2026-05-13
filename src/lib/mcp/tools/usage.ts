import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getUsage } from "@/lib/data";
import type { AggregatorPeriod } from "@/lib/usage/period";
import {
  SlugSchema,
  UsagePeriodSchema,
} from "../schemas";
import { jsonResult, textResult } from "../result";

// The aggregator's period type is wider than our schema (it accepts legacy
// week/month aliases too). The cast is safe — our schema is a strict subset.
function toAggregatorPeriod(p: z.infer<typeof UsagePeriodSchema>): AggregatorPeriod {
  return p as AggregatorPeriod;
}

export function registerUsageTools(server: McpServer): void {
  server.registerTool(
    "get-usage",
    {
      title: "Get token usage report",
      description:
        "Returns a full UsageReport for the given period: total tokens, cost, breakdown by " +
        "model, project, tool, work-mode category, daily buckets, and self-correction streaks. " +
        "Optional `project` filters to one project slug; `source` filters by coding-agent " +
        "(claude | codex | gemini — default is all sources).",
      inputSchema: {
        period: UsagePeriodSchema,
        project: SlugSchema.optional(),
        source: z.string().optional().describe("Adapter id: claude, codex, gemini, etc."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period, project, source }) => {
      const result = await getUsage(toAggregatorPeriod(period), project, source);
      return jsonResult({
        backend: result.meta.backend,
        report: result.report,
      });
    }
  );

  server.registerTool(
    "get-usage-by-day",
    {
      title: "Daily token usage breakdown",
      description:
        "Returns just the daily-bucket slice of the usage report — date, input/output tokens, " +
        "cache reads/writes, cost, turn count. Smaller payload than `get-usage` when the model " +
        "only needs a time series.",
      inputSchema: {
        period: UsagePeriodSchema,
        project: SlugSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period, project }) => {
      const { report } = await getUsage(toAggregatorPeriod(period), project);
      return jsonResult({
        period,
        project,
        daily: report.daily,
      });
    }
  );

  server.registerTool(
    "get-usage-by-tool",
    {
      title: "Tool/shell/MCP usage breakdown",
      description:
        "Returns the tool-call breakdown from the usage report: top-N tool counts, shell " +
        "command groupings (Bash/PowerShell binaries) and MCP server invocation stats, plus " +
        "tool-to-tool transition patterns.",
      inputSchema: {
        period: UsagePeriodSchema,
        project: SlugSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period, project }) => {
      const { report } = await getUsage(toAggregatorPeriod(period), project);
      return jsonResult({
        period,
        project,
        topTools: report.topTools,
        toolTransitions: report.toolTransitions,
        toolSelfLoops: report.toolSelfLoops,
        shellStats: report.shellStats,
        mcpStats: report.mcpStats,
      });
    }
  );

  server.registerTool(
    "get-usage-by-category",
    {
      title: "Work-category cost breakdown",
      description:
        "Returns cost and turn counts grouped by the 13-category work classifier (Git Ops, " +
        "Build/Deploy, Testing, Debugging, Refactoring, Delegation, Planning, Brainstorming, " +
        "Exploration, Feature Dev, Coding, Conversation, General).",
      inputSchema: {
        period: UsagePeriodSchema,
        project: SlugSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period, project }) => {
      const { report } = await getUsage(toAggregatorPeriod(period), project);
      return jsonResult({
        period,
        project,
        byCategory: report.byCategory,
      });
    }
  );

  server.registerTool(
    "get-one-shot-stats",
    {
      title: "One-shot vs retry-cycle stats",
      description:
        "Returns the detector's view of how often edits succeed first try vs require " +
        "Edit→Bash→re-edit retry cycles. Includes the verified-task count, one-shot count, " +
        "and overall rate. Useful for surfacing 'where am I wasting tokens on retries?' patterns.",
      inputSchema: {
        period: UsagePeriodSchema,
        project: SlugSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period, project }) => {
      const { report } = await getUsage(toAggregatorPeriod(period), project);
      return jsonResult({
        period,
        project,
        oneShot: report.oneShot,
      });
    }
  );

  server.registerTool(
    "export-usage",
    {
      title: "Export usage as CSV or JSON",
      description:
        "Returns the usage report serialized as CSV (one row per day-model combo) or " +
        "indented JSON. Use this when the user wants raw data to import into a spreadsheet.",
      inputSchema: {
        format: z.enum(["csv", "json"]).default("json"),
        period: UsagePeriodSchema,
        project: SlugSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ format, period, project }) => {
      const { report } = await getUsage(toAggregatorPeriod(period), project);
      if (format === "json") return jsonResult(report);

      const rows = ["date,inputTokens,outputTokens,turns,cost"];
      for (const day of report.daily) {
        // DailyBucket fields: date, cost, inputTokens, outputTokens, turns.
        // Cache tokens are aggregated at the report level, not per day — if
        // a user needs that granularity they should ask for `get-usage` (full
        // report) and slice it themselves.
        rows.push(
          [day.date, day.inputTokens, day.outputTokens, day.turns, day.cost].join(",")
        );
      }
      return textResult(rows.join("\n"));
    }
  );
}
