import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getCurrentStatus } from "@/lib/claudeStatus/cache";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { jsonResult } from "../result";

export function registerClaudeStatusTools(server: McpServer): void {
  server.registerTool(
    "get-claude-status",
    {
      title: "Get current Claude service status",
      description:
        "Returns active Claude incidents and per-component health pulled from status.claude.com's " +
        "Statuspage summary API. Use this to determine whether an API error or Claude.ai/Claude " +
        "Code issue the user reports is caused by an upstream incident vs. a local problem. " +
        "Includes overall severity, the affected components, the latest incident-update body, " +
        "and a `source` field that flags stale-vs-live data. By default, components currently " +
        "marked `operational` are omitted from the result to keep the payload focused on what's " +
        "actionable.",
      inputSchema: {
        includeOperationalComponents: z
          .boolean()
          .default(false)
          .describe("Include components currently in `operational` status. Default false — return only currently-degraded components."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ includeOperationalComponents }) => {
      const config = await readConfig();
      if (!getFlag(config.featureFlags, "claudeStatusAlerts")) {
        return jsonResult({
          disabled: true,
          reason: "claudeStatusAlerts feature flag is off in this project's .minder.json. Enable it via the Project Minder Settings page.",
        });
      }

      const snapshot = await getCurrentStatus();
      const components = includeOperationalComponents
        ? snapshot.components
        : snapshot.components.filter((c) => c.status !== "operational");

      return jsonResult({
        overall: snapshot.overall,
        source: snapshot.source,
        fetchedAt: snapshot.fetchedAt ? new Date(snapshot.fetchedAt).toISOString() : null,
        lastError: snapshot.lastError,
        page: snapshot.page,
        componentCount: snapshot.components.length,
        components,
        incidents: snapshot.incidents,
      });
    },
  );
}
