import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadCatalog, invalidateCatalogCache } from "@/lib/indexer/catalog";
import { getAgentUsage, getSkillUsage } from "@/lib/data";
import type { AgentEntry, SkillEntry } from "@/lib/indexer/types";
import {
  SlugSchema,
  CatalogSourceSchema,
  AgentUsagePeriodSchema,
} from "../schemas";
import { jsonResult, errorResult } from "../result";

function matchesQuery(entry: AgentEntry | SkillEntry, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    entry.name.toLowerCase().includes(needle) ||
    entry.slug.toLowerCase().includes(needle) ||
    (entry.description ?? "").toLowerCase().includes(needle) ||
    entry.bodyExcerpt.toLowerCase().includes(needle)
  );
}

function filterCatalog<T extends AgentEntry | SkillEntry>(
  entries: T[],
  filter: { source?: string; project?: string; q?: string }
): T[] {
  let out = entries;
  if (filter.source) out = out.filter((e) => e.source === filter.source);
  if (filter.project) out = out.filter((e) => e.projectSlug === filter.project);
  if (filter.q) {
    const q = filter.q;
    out = out.filter((e) => matchesQuery(e, q));
  }
  return out;
}

export function registerCatalogTools(server: McpServer): void {
  server.registerTool(
    "list-agents",
    {
      title: "List Claude Code agents",
      description:
        "Returns the catalog of agents available to Claude Code: user-global (~/.claude/agents), " +
        "plugin-provided, and project-local. Each entry includes name, source, description, " +
        "frontmatter, body excerpt, and provenance (which marketplace/lockfile/repo it came from).",
      inputSchema: {
        source: CatalogSourceSchema.optional(),
        project: SlugSchema.optional().describe("Filter to project-local agents from one project"),
        q: z.string().min(1).optional().describe("Substring match against name, slug, description, body"),
        includeProjects: z
          .boolean()
          .default(true)
          .describe("Also include project-local agents (default true)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ source, project, q, includeProjects }) => {
      const { agents } = await loadCatalog({ includeProjects });
      const filtered = filterCatalog(agents, { source, project, q });
      return jsonResult({ total: filtered.length, agents: filtered });
    }
  );

  server.registerTool(
    "get-agent",
    {
      title: "Get agent body + usage stats",
      description:
        "Returns the full AgentEntry (body excerpt, frontmatter, provenance, file path) plus " +
        "cross-project invocation stats (per-project invocation count, total cost, last used).",
      inputSchema: { id: z.string().min(1).describe("Agent id (path-based stable identifier)") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const { agents } = await loadCatalog({ includeProjects: true });
      const agent = agents.find((a) => a.id === id);
      if (!agent) {
        return errorResult(`No agent with id '${id}'. Try 'list-agents' first.`);
      }

      const { stats } = await getAgentUsage("all");
      const usage = stats.find(
        (s) => s.name.toLowerCase() === agent.name.toLowerCase() || s.name === agent.slug
      );

      return jsonResult({ agent, usage: usage ?? null });
    }
  );

  server.registerTool(
    "list-skills",
    {
      title: "List Claude Code skills",
      description:
        "Returns the catalog of skills (bundled SKILL.md directories or standalone .md files) " +
        "available to Claude Code, with same filtering options as `list-agents`.",
      inputSchema: {
        source: CatalogSourceSchema.optional(),
        project: SlugSchema.optional(),
        q: z.string().min(1).optional(),
        includeProjects: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ source, project, q, includeProjects }) => {
      const { skills } = await loadCatalog({ includeProjects });
      const filtered = filterCatalog(skills, { source, project, q });
      return jsonResult({ total: filtered.length, skills: filtered });
    }
  );

  server.registerTool(
    "get-skill",
    {
      title: "Get skill body + usage stats",
      description:
        "Returns the full SkillEntry plus invocation stats (per-project invocation count, " +
        "last-used date) across all sessions.",
      inputSchema: { id: z.string().min(1).describe("Skill id (path-based stable identifier)") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const { skills } = await loadCatalog({ includeProjects: true });
      const skill = skills.find((s) => s.id === id);
      if (!skill) {
        return errorResult(`No skill with id '${id}'. Try 'list-skills' first.`);
      }

      const { stats } = await getSkillUsage("all");
      const usage = stats.find(
        (s) => s.name.toLowerCase() === skill.name.toLowerCase() || s.name === skill.slug
      );

      return jsonResult({ skill, usage: usage ?? null });
    }
  );

  server.registerTool(
    "get-agent-usage",
    {
      title: "Cross-project agent invocation stats",
      description:
        "Returns invocation counts, project breakdown, and (when period='all') cost / token " +
        "totals per agent across the indexed history.",
      inputSchema: { period: AgentUsagePeriodSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period }) => {
      const { stats, meta } = await getAgentUsage(period);
      return jsonResult({ backend: meta.backend, total: stats.length, stats });
    }
  );

  server.registerTool(
    "get-skill-usage",
    {
      title: "Cross-project skill invocation stats",
      description: "Returns invocation counts and project breakdown per skill.",
      inputSchema: { period: AgentUsagePeriodSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period }) => {
      const { stats, meta } = await getSkillUsage(period);
      return jsonResult({ backend: meta.backend, total: stats.length, stats });
    }
  );

  server.registerTool(
    "refresh-catalog",
    {
      title: "Re-walk agent and skill directories",
      description:
        "Invalidates the 5-minute catalog cache and re-walks ~/.claude/agents, ~/.claude/skills, " +
        "all installed plugin directories, and (if includeProjects) project-local .claude/.",
      inputSchema: { includeProjects: z.boolean().default(true) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ includeProjects }) => {
      invalidateCatalogCache();
      const result = await loadCatalog({ includeProjects });
      return jsonResult({
        agentCount: result.agents.length,
        skillCount: result.skills.length,
      });
    }
  );
}
