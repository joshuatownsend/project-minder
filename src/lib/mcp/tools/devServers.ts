import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { processManager } from "@/lib/processManager";
import { SlugSchema } from "../schemas";
import { jsonResult, errorResult } from "../result";

// Read-only dev-server tools. The 'safe writes' scope deliberately excludes
// process control (start/stop/restart) — those have larger blast radius
// (binding ports, spawning child processes, killing process trees) than the
// other writes in this set. Add them later if/when the user wants that.

export function registerDevServerTools(server: McpServer): void {
  server.registerTool(
    "list-dev-servers",
    {
      title: "List managed dev servers",
      description:
        "Returns every dev server Project Minder has spawned this session: slug, project path, " +
        "pid, port, command, start time, and current status (starting/running/stopped/errored).",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      // Strip the per-process output array from the list view to keep the
      // payload small. Use `get-dev-server-output` for full stdout/stderr.
      const lite = processManager.getAll().map(({ output: _output, ...rest }) => rest);
      return jsonResult({ total: lite.length, servers: lite });
    }
  );

  server.registerTool(
    "get-dev-server-output",
    {
      title: "Get last N lines of dev-server output",
      description:
        "Returns recent stdout/stderr lines for one managed dev server. The process manager " +
        "keeps the last 200 lines per process.",
      inputSchema: {
        slug: SlugSchema,
        lines: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug, lines }) => {
      const info = processManager.get(slug);
      if (!info) {
        return errorResult(
          `No dev server tracked for '${slug}'. Use 'list-dev-servers' to see what's running.`
        );
      }
      return jsonResult({
        slug,
        status: info.status,
        port: info.port,
        pid: info.pid,
        output: info.output.slice(-lines),
      });
    }
  );
}
