import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { gitStatusCache } from "@/lib/gitStatusCache";
import { scanGitDirtyStatus } from "@/lib/scanner/git";
import { SlugSchema } from "../schemas";
import { jsonResult, errorResult } from "../result";
import { getCachedOrFreshScan as getScan } from "../scanHelper";

export function registerGitTools(server: McpServer): void {
  server.registerTool(
    "get-git-status",
    {
      title: "Get git dirty status for all projects",
      description:
        "Returns the cached dirty/clean status per project (5-minute TTL). The dashboard polls " +
        "this in the background as projects get scanned. Use `refresh-git-status` to force an " +
        "immediate re-check.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const statuses = gitStatusCache.getAll();
      return jsonResult({
        cached: gitStatusCache.total,
        pending: gitStatusCache.pending,
        statuses,
      });
    }
  );

  server.registerTool(
    "refresh-git-status",
    {
      title: "Force a fresh git status check",
      description:
        "Runs `git status --porcelain` against one project (if slug is given) or enqueues " +
        "every scanned project for a fresh check. The cache is updated in-place; callers may " +
        "follow up with `get-git-status` to read the new values.",
      inputSchema: {
        slug: SlugSchema.optional().describe(
          "Project slug to refresh; omit to enqueue every project"
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ slug }) => {
      const scan = await getScan();
      if (slug) {
        const project = scan.projects.find((p) => p.slug === slug);
        if (!project) return errorResult(`No project with slug '${slug}'.`);
        try {
          const status = await scanGitDirtyStatus(project.path);
          gitStatusCache.set(slug, status.isDirty, status.uncommittedCount, status.unknown);
          return jsonResult({ slug, status });
        } catch (err) {
          return errorResult(`git status failed: ${(err as Error).message}`);
        }
      }

      const items = scan.projects.map((p) => ({ slug: p.slug, path: p.path }));
      gitStatusCache.enqueue(items);
      return jsonResult({
        enqueued: items.length,
        pending: gitStatusCache.pending,
      });
    }
  );
}
