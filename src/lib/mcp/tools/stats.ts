import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { computeStats } from "@/lib/stats";
import { getClaudeUsage } from "@/lib/data";
import { efficiencyGradeCache } from "@/lib/efficiencyGradeCache";
import { gatherContextOverhead } from "@/lib/contextOverheadComposed";
import { parseAllSessions } from "@/lib/usage/parser";
import { gatherProjectTurns } from "@/lib/usage/projectMatch";
import { readConfig } from "@/lib/config";
import { buildHotFiles } from "@/lib/usage/fileTracker";
import { buildErrorPropagation } from "@/lib/usage/errorPropagation";
import { buildFileCoupling } from "@/lib/usage/fileCoupling";
import { getProjectGitActivity } from "@/lib/projectGitActivity";
import { SlugSchema } from "../schemas";
import { jsonResult, errorResult } from "../result";
import { getCachedOrFreshScan as getScan } from "../scanHelper";

export function registerStatsTools(server: McpServer): void {
  server.registerTool(
    "get-portfolio-stats",
    {
      title: "Portfolio-wide statistics",
      description:
        "Returns aggregated stats across all projects: framework distribution, database types, " +
        "external services, TODO health, activity buckets, and Claude usage totals. Same shape " +
        "the /stats dashboard renders.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const scan = await getScan();
      const projectPaths = scan.projects.map((p) => p.path);
      const claudeUsage = await getClaudeUsage(projectPaths);
      const stats = computeStats(scan.projects, scan.hiddenCount, claudeUsage.stats);
      return jsonResult({
        backend: claudeUsage.meta.backend,
        scannedAt: scan.scannedAt,
        stats,
      });
    }
  );

  server.registerTool(
    "get-efficiency-grades",
    {
      title: "Per-project efficiency grades",
      description:
        "Returns the cached letter-grade (A/B/C/D/F) computed by the waste optimizer for each " +
        "project that has Claude sessions. Grades are computed in the background after a scan; " +
        "this returns only what's currently cached (pending items are still processing).",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      // getAll() returns Record<slug, EfficiencyGrade> where the value is
      // the letter directly — not a wrapper object.
      const grades = efficiencyGradeCache.getAll();
      return jsonResult({
        cached: efficiencyGradeCache.total,
        pending: efficiencyGradeCache.pending,
        grades,
      });
    }
  );

  server.registerTool(
    "get-context-overhead",
    {
      title: "Portfolio-wide context overhead estimate",
      description:
        "Returns the theoretical-vs-observed startup-context breakdown: system prompt baseline, " +
        "MCP servers, skills (ceiling), hooks, user CLAUDE.md, and the gap between known sum " +
        "and observed startup tokens.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => jsonResult(await gatherContextOverhead())
  );

  server.registerTool(
    "get-project-hot-files",
    {
      title: "Most-edited files in a project",
      description:
        "Returns the top-N most frequently edited files for one project, based on file_edits " +
        "in the indexed sessions. Useful for surfacing 'where is most of the activity happening?'.",
      inputSchema: {
        slug: SlugSchema,
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug, limit }) => {
      const scan = await getScan();
      const project = scan.projects.find((p) => p.slug === slug);
      if (!project) return errorResult(`No project with slug '${slug}'.`);
      const sessionMap = await parseAllSessions();
      const turns = gatherProjectTurns(
        sessionMap, slug, project.path, (await readConfig()).pathMappings ?? []
      );
      const result = buildHotFiles(turns, limit);
      return jsonResult({ slug, result });
    }
  );

  server.registerTool(
    "get-project-error-propagation",
    {
      title: "Error propagation analysis for a project",
      description:
        "Returns per-agent and per-tool error stats, depth buckets, and propagation chains for " +
        "one project's session history.",
      inputSchema: { slug: SlugSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const scan = await getScan();
      const project = scan.projects.find((p) => p.slug === slug);
      if (!project) return errorResult(`No project with slug '${slug}'.`);
      // buildErrorPropagation reads JSONL files directly under ~/.claude/projects/<encoded-path>/
      // rather than taking pre-parsed turns — it computes depth-aware error stats that need the
      // raw turn structure.
      const report = await buildErrorPropagation(project.path);
      return jsonResult({ slug, report });
    }
  );

  server.registerTool(
    "get-project-file-coupling",
    {
      title: "File coupling graph for a project",
      description:
        "Returns pairs of files that are frequently edited together in the same session, with " +
        "co-edit counts. Useful for spotting hidden dependencies between modules.",
      inputSchema: {
        slug: SlugSchema,
        minOccurrences: z.number().int().min(2).max(50).default(3),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug, minOccurrences }) => {
      const scan = await getScan();
      const project = scan.projects.find((p) => p.slug === slug);
      if (!project) return errorResult(`No project with slug '${slug}'.`);
      const sessionMap = await parseAllSessions();
      const turns = gatherProjectTurns(
        sessionMap, slug, project.path, (await readConfig()).pathMappings ?? []
      );
      const result = buildFileCoupling(turns, minOccurrences);
      return jsonResult({ slug, result });
    }
  );

  server.registerTool(
    "get-project-git-activity",
    {
      title: "Git activity summary for a project",
      description:
        "Aggregates per-branch commit/file-change activity for one project. Backed by git log " +
        "subprocess output — runs on demand.",
      inputSchema: { slug: SlugSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const scan = await getScan();
      const project = scan.projects.find((p) => p.slug === slug);
      if (!project) return errorResult(`No project with slug '${slug}'.`);
      const activity = await getProjectGitActivity(slug, project.path);
      return jsonResult({ slug, activity });
    }
  );
}
