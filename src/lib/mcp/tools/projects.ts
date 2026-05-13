import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { toSlug } from "@/lib/scanner";
import { invalidateCache } from "@/lib/cache";
import { readConfig, mutateConfig } from "@/lib/config";
import {
  SlugSchema,
  ProjectStatusSchema,
} from "../schemas";
import { jsonResult, errorResult } from "../result";
import { getCachedOrFreshScan } from "../scanHelper";

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "list-projects",
    {
      title: "List scanned projects",
      description:
        "Returns every project Project Minder has scanned in the configured devRoot(s). " +
        "Uses the 5-minute scan cache when warm. Filter by status (active/paused/archived) or " +
        "search term `q` matched against name and slug.",
      inputSchema: {
        status: ProjectStatusSchema.optional(),
        q: z.string().min(1).optional().describe("Substring filter on slug or name (case-insensitive)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, q }) => {
      const scan = await getCachedOrFreshScan();

      let projects = scan.projects;
      if (status) projects = projects.filter((p) => p.status === status);
      if (q) {
        const needle = q.toLowerCase();
        projects = projects.filter(
          (p) => p.slug.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle)
        );
      }

      return jsonResult({
        total: projects.length,
        portConflicts: scan.portConflicts,
        scannedAt: scan.scannedAt,
        projects,
      });
    }
  );

  server.registerTool(
    "get-project",
    {
      title: "Get project detail",
      description:
        "Returns the full ProjectData for a single project, including framework, dependencies, " +
        "git status, Claude session summary, manual steps, insights, hooks, MCP servers, and " +
        "GSD planning info.",
      inputSchema: { slug: SlugSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const scan = await getCachedOrFreshScan();
      const project = scan.projects.find((p) => p.slug === slug);
      if (!project) {
        return errorResult(
          `No project with slug '${slug}'. Try 'list-projects' to see available slugs.`
        );
      }
      return jsonResult(project);
    }
  );

  server.registerTool(
    "scan-projects",
    {
      title: "Force a project rescan",
      description:
        "Invalidates the 5-minute scan cache and re-walks every devRoot. Use when the user has " +
        "added, renamed, or removed projects on disk and wants Project Minder to pick up the " +
        "changes immediately. Returns the new scan result.",
      inputSchema: {
        force: z
          .boolean()
          .default(true)
          .describe("Set to false to return the cached scan if still fresh"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ force }) => {
      if (force) invalidateCache();
      const start = Date.now();
      const scan = await getCachedOrFreshScan();
      return jsonResult({
        scannedInMs: Date.now() - start,
        projectCount: scan.projects.length,
        hiddenCount: scan.hiddenCount,
        portConflicts: scan.portConflicts,
        scannedAt: scan.scannedAt,
      });
    }
  );

  server.registerTool(
    "get-project-config",
    {
      title: "Read .minder.json",
      description:
        "Returns the current Project Minder configuration: project statuses, hidden list, port " +
        "overrides, devRoot(s), pinned slugs, feature flags.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => jsonResult(await readConfig())
  );

  server.registerTool(
    "update-project-config",
    {
      title: "Update project status, hidden, or port override",
      description:
        "Applies a targeted change to .minder.json for one project — status (active/paused/archived), " +
        "hidden flag, or port override. Other config keys are preserved. Returns the updated config.",
      inputSchema: {
        slug: SlugSchema,
        status: ProjectStatusSchema.optional(),
        hidden: z.boolean().optional().describe("Hide the project from dashboard listings"),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .nullable()
          .optional()
          .describe("Override the dev-server port. Pass null to clear an existing override."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ slug, status, hidden, port }) => {
      if (status === undefined && hidden === undefined && port === undefined) {
        return errorResult(
          "Nothing to update — provide at least one of status, hidden, or port."
        );
      }

      const next = await mutateConfig((config) => {
        if (status !== undefined) {
          config.statuses[slug] = status;
        }
        if (hidden !== undefined) {
          // The hidden list stores raw directory names (preserving original
          // casing); match by `toSlug` so callers passing the canonical slug
          // still hit the right entry regardless of source casing.
          if (hidden) {
            const already = config.hidden.some((h) => toSlug(h) === slug);
            if (!already) config.hidden.push(slug);
          } else {
            config.hidden = config.hidden.filter((h) => toSlug(h) !== slug);
          }
        }
        if (port !== undefined) {
          if (port === null) {
            delete config.portOverrides[slug];
          } else {
            config.portOverrides[slug] = port;
          }
        }
      });

      // Force scan cache invalidation so the next list-projects reflects the change.
      invalidateCache();

      return jsonResult(next);
    }
  );
}
