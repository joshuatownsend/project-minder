import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getSessionsList,
  getSessionDetail,
  searchSessions,
  onlyEnabledSources,
} from "@/lib/data";
import { SessionIdSchema, SlugSchema } from "../schemas";
import { jsonResult, errorResult } from "../result";

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    "list-sessions",
    {
      title: "List Claude Code sessions",
      description:
        "Returns session summaries across all projects. Each summary includes tokens, cost, " +
        "duration, model usage, tool counts, subagent count, and quality flags (compaction loop, " +
        "tool failure streak, thinking, resume anomaly). Filter by project slug and/or limit count.",
      inputSchema: {
        project: SlugSchema.optional(),
        limit: z.number().int().min(1).max(500).optional(),
        starredOnly: z
          .boolean()
          .optional()
          .describe("Only return sessions the user has starred"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project, limit, starredOnly }) => {
      const { sessions, meta } = await getSessionsList();
      let filtered = await onlyEnabledSources(sessions);
      if (project) filtered = filtered.filter((s) => s.projectSlug === project);
      if (starredOnly) filtered = filtered.filter((s) => s.starredAt);
      if (limit) filtered = filtered.slice(0, limit);
      return jsonResult({
        backend: meta.backend,
        total: filtered.length,
        sessions: filtered,
      });
    }
  );

  server.registerTool(
    "get-session",
    {
      title: "Get full session detail",
      description:
        "Returns a SessionDetail for a single session — accepts either the raw sessionId UUID " +
        "or the human-readable slug (e.g. 'quirky-scribbling-plum'). Includes timeline (turns " +
        "and tool calls), file operations, and subagent invocations.",
      inputSchema: { sessionId: SessionIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ sessionId }) => {
      const { detail, meta } = await getSessionDetail(sessionId);
      if (!detail) {
        return errorResult(
          `No session found for '${sessionId}'. Try 'list-sessions' to find an existing sessionId or slug.`
        );
      }
      return jsonResult({ backend: meta.backend, detail });
    }
  );

  server.registerTool(
    "search-sessions",
    {
      title: "Full-text search across sessions",
      description:
        "Search session titles and/or prompts. DB-backed when MINDER_USE_DB=1 (FTS5 index); " +
        "falls back to a substring scan across session summaries otherwise (backend 'file'). " +
        "Returns matching session hits with the matching context.",
      inputSchema: {
        q: z.string().min(1),
        scope: z.enum(["titles", "prompts", "both"]).default("both"),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ q, scope, limit }) => {
      const result = await searchSessions(q, scope, limit);

      return jsonResult({
        backend: result.meta.backend,
        total: result.hits.length,
        hits: result.hits,
      });
    }
  );
}
