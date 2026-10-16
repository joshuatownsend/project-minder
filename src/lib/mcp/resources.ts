import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import { readConfig } from "@/lib/config";
import { loadCatalog } from "@/lib/indexer/catalog";
import { getUsage, getSessionDetail, getSessionsList, getClaudeUsage } from "@/lib/data";
import { computeStats } from "@/lib/stats";
import { getCachedOrFreshScan as getScan } from "./scanHelper";

// Resources are URI-addressable context blobs. In Claude Desktop the user
// can attach a resource as conversation context without an explicit tool
// call. Templates (`minder://projects/{slug}`) advertise a `list` callback
// so clients can browse and auto-discover entries.

function jsonResource(uri: URL, payload: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function registerResources(server: McpServer): void {
  // ── Static singletons ──────────────────────────────────────────────────
  server.registerResource(
    "config",
    "minder://config",
    {
      title: "Project Minder configuration",
      description: "Current .minder.json contents (statuses, hidden list, port overrides, devRoots, feature flags).",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, await readConfig())
  );

  server.registerResource(
    "stats",
    "minder://stats",
    {
      title: "Portfolio statistics snapshot",
      description: "Aggregated portfolio stats — framework distribution, activity buckets, Claude usage totals.",
      mimeType: "application/json",
    },
    async (uri) => {
      const scan = await getScan();
      const claudeUsage = await getClaudeUsage(scan.projects.map((p) => p.path));
      const stats = computeStats(scan.projects, scan.hiddenCount, claudeUsage.stats);
      return jsonResource(uri, { backend: claudeUsage.meta.backend, stats });
    }
  );

  // ── Projects (template) ────────────────────────────────────────────────
  server.registerResource(
    "project",
    new ResourceTemplate("minder://projects/{slug}", {
      list: async () => {
        const scan = await getScan();
        return {
          resources: scan.projects.map((p) => ({
            uri: `minder://projects/${p.slug}`,
            name: p.name,
            description: `${p.framework ?? "unknown stack"} · ${p.status}`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Project detail",
      description: "Full ProjectData for one project — pass {slug}.",
    },
    async (uri, variables) => {
      const slug = String(variables.slug);
      const scan = await getScan();
      const project = scan.projects.find((p) => p.slug === slug);
      if (!project) {
        return jsonResource(uri, { error: `No project with slug '${slug}'` });
      }
      return jsonResource(uri, project);
    }
  );

  // ── Project sub-resources ──────────────────────────────────────────────
  server.registerResource(
    "project-insights",
    new ResourceTemplate("minder://projects/{slug}/insights", { list: undefined }),
    {
      title: "Project INSIGHTS.md",
      description: "Parsed INSIGHTS.md entries for one project.",
    },
    async (uri, variables) => {
      const slug = String(variables.slug);
      const scan = await getScan();
      const project = scan.projects.find((p) => p.slug === slug);
      return jsonResource(uri, project?.insights ?? { entries: [], total: 0 });
    }
  );

  server.registerResource(
    "project-manual-steps",
    new ResourceTemplate("minder://projects/{slug}/manual-steps", { list: undefined }),
    {
      title: "Project MANUAL_STEPS.md",
      description: "Parsed MANUAL_STEPS.md entries for one project.",
    },
    async (uri, variables) => {
      const slug = String(variables.slug);
      const scan = await getScan();
      const project = scan.projects.find((p) => p.slug === slug);
      return jsonResource(
        uri,
        project?.manualSteps ?? { entries: [], totalSteps: 0, pendingSteps: 0, completedSteps: 0 }
      );
    }
  );

  server.registerResource(
    "project-sessions",
    new ResourceTemplate("minder://projects/{slug}/sessions", { list: undefined }),
    {
      title: "Sessions for a project",
      description: "All Claude Code SessionSummary entries for one project, newest first.",
    },
    async (uri, variables) => {
      const slug = String(variables.slug);
      const { sessions, meta } = await getSessionsList();
      const filtered = sessions.filter((s) => s.projectSlug === slug);
      return jsonResource(uri, { backend: meta.backend, total: filtered.length, sessions: filtered });
    }
  );

  // ── Sessions (template) ────────────────────────────────────────────────
  server.registerResource(
    "session",
    new ResourceTemplate("minder://sessions/{sessionId}", {
      list: async () => {
        const { sessions } = await getSessionsList();
        // Cap to 200 — listings of all sessions can be huge on long-time users
        // and the MCP list payload should fit comfortably in context.
        return {
          resources: sessions.slice(0, 200).map((s) => ({
            uri: `minder://sessions/${s.sessionId}`,
            name: s.generatedTitle ?? s.slug ?? s.sessionId,
            description: `${s.projectSlug} · ${s.startTime ?? "(no start)"}`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Session detail",
      description: "Full SessionDetail (timeline, file ops, subagents) — pass {sessionId} or slug.",
    },
    async (uri, variables) => {
      const sessionId = String(variables.sessionId);
      const { detail, meta } = await getSessionDetail(sessionId);
      if (!detail) {
        return jsonResource(uri, { error: `No session for '${sessionId}'` });
      }
      return jsonResource(uri, { backend: meta.backend, detail });
    }
  );

  // ── Agents (template) ──────────────────────────────────────────────────
  server.registerResource(
    "agent",
    new ResourceTemplate("minder://agents/{id}", {
      list: async () => {
        const { agents } = await loadCatalog({ includeProjects: true });
        return {
          resources: agents.map((a) => ({
            uri: `minder://agents/${encodeURIComponent(a.id)}`,
            name: a.name,
            description: a.description ?? `${a.source} agent`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Agent detail",
      description: "Agent body, frontmatter, and provenance — pass {id}.",
    },
    async (uri, variables) => {
      const id = decodeURIComponent(String(variables.id));
      const { agents } = await loadCatalog({ includeProjects: true });
      const agent = agents.find((a) => a.id === id);
      if (!agent) return jsonResource(uri, { error: `No agent '${id}'` });
      return jsonResource(uri, agent);
    }
  );

  // ── Skills (template) ──────────────────────────────────────────────────
  server.registerResource(
    "skill",
    new ResourceTemplate("minder://skills/{id}", {
      list: async () => {
        const { skills } = await loadCatalog({ includeProjects: true });
        return {
          resources: skills.map((s) => ({
            uri: `minder://skills/${encodeURIComponent(s.id)}`,
            name: s.name,
            description: s.description ?? `${s.source} skill`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Skill detail",
      description: "Skill body, frontmatter, and provenance — pass {id}.",
    },
    async (uri, variables) => {
      const id = decodeURIComponent(String(variables.id));
      const { skills } = await loadCatalog({ includeProjects: true });
      const skill = skills.find((s) => s.id === id);
      if (!skill) return jsonResource(uri, { error: `No skill '${id}'` });
      return jsonResource(uri, skill);
    }
  );

  // ── Usage by period (template) ─────────────────────────────────────────
  server.registerResource(
    "usage-period",
    new ResourceTemplate("minder://usage/{period}", {
      list: async () => ({
        resources: (["today", "7d", "30d", "all"] as const).map((p) => ({
          uri: `minder://usage/${p}`,
          name: `Usage — ${p}`,
          description: `Token usage report for period ${p}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Usage report",
      description: "UsageReport for the given period (today, 7d, 30d, or all).",
    },
    async (uri, variables) => {
      const period = String(variables.period);
      const valid = ["24h", "today", "7d", "30d", "all", "week", "month"];
      const safePeriod = valid.includes(period) ? period : "7d";
      // Cast — getUsage accepts AggregatorPeriod which is wider than our schema.
      const result = await getUsage(safePeriod as Parameters<typeof getUsage>[0]);
      return jsonResource(uri, { backend: result.meta.backend, report: result.report });
    }
  );
}
