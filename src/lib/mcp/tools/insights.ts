import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SlugSchema } from "../schemas";
import { jsonResult, errorResult } from "../result";
import { getCachedOrFreshScan as getScan } from "../scanHelper";

export function registerInsightsTools(server: McpServer): void {
  server.registerTool(
    "list-insights",
    {
      title: "Search insights across projects",
      description:
        "Returns INSIGHTS.md entries across all projects. Each insight carries the content, " +
        "session it came from, date, and project. Optional `q` matches against insight content " +
        "(case-insensitive substring); `project` limits to one project slug.",
      inputSchema: {
        q: z.string().min(1).optional(),
        project: SlugSchema.optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ q, project, limit }) => {
      const scan = await getScan();
      const hits: Array<{
        slug: string;
        projectName: string;
        id: string;
        content: string;
        sessionId: string;
        date: string;
      }> = [];

      const needle = q?.toLowerCase();
      for (const p of scan.projects) {
        if (project && p.slug !== project) continue;
        if (!p.insights || p.insights.total === 0) continue;
        for (const entry of p.insights.entries) {
          if (needle && !entry.content.toLowerCase().includes(needle)) continue;
          hits.push({
            slug: p.slug,
            projectName: p.name,
            id: entry.id,
            content: entry.content,
            sessionId: entry.sessionId,
            date: entry.date,
          });
          if (hits.length >= limit) break;
        }
        if (hits.length >= limit) break;
      }

      return jsonResult({ total: hits.length, insights: hits });
    }
  );

  server.registerTool(
    "get-project-insights",
    {
      title: "Get a project's insights",
      description:
        "Returns parsed INSIGHTS.md entries for one project, oldest-first as stored on disk.",
      inputSchema: { slug: SlugSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const scan = await getScan();
      const project = scan.projects.find((p) => p.slug === slug);
      if (!project) {
        return errorResult(`No project with slug '${slug}'.`);
      }
      return jsonResult({
        slug,
        path: project.path,
        insights: project.insights ?? { entries: [], total: 0 },
      });
    }
  );
}
