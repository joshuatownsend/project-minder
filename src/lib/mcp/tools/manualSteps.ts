import { z } from "zod";
import path from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { toggleStepInFile } from "@/lib/manualStepsWriter";
import { SlugSchema } from "../schemas";
import { jsonResult, errorResult } from "../result";
import { getCachedOrFreshScan as getScan } from "../scanHelper";

export function registerManualStepsTools(server: McpServer): void {
  server.registerTool(
    "list-manual-steps",
    {
      title: "List manual steps across projects",
      description:
        "Returns every MANUAL_STEPS.md entry across all scanned projects. Useful for surfacing " +
        "outstanding human-action items the developer has accumulated. `pending` defaults to true " +
        "(only show projects with unchecked steps); set false to include completed steps too.",
      inputSchema: {
        pending: z
          .boolean()
          .default(true)
          .describe("Only return projects with pending (unchecked) steps"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pending }) => {
      const scan = await getScan();
      const projects = scan.projects
        .filter((p) => p.manualSteps && p.manualSteps.totalSteps > 0)
        .filter((p) => (pending ? (p.manualSteps?.pendingSteps ?? 0) > 0 : true))
        .map((p) => ({
          slug: p.slug,
          name: p.name,
          path: p.path,
          manualSteps: p.manualSteps,
        }));
      return jsonResult({ total: projects.length, projects });
    }
  );

  server.registerTool(
    "get-project-manual-steps",
    {
      title: "Get a project's manual steps",
      description:
        "Returns parsed MANUAL_STEPS.md entries for one project: features, dates, step text, " +
        "completion state, indented detail lines, and line numbers (for use with toggle).",
      inputSchema: { slug: SlugSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug }) => {
      const scan = await getScan();
      const project = scan.projects.find((p) => p.slug === slug);
      if (!project) {
        return errorResult(`No project with slug '${slug}'.`);
      }
      if (!project.manualSteps || project.manualSteps.totalSteps === 0) {
        return jsonResult({
          slug,
          path: project.path,
          manualSteps: { entries: [], totalSteps: 0, pendingSteps: 0, completedSteps: 0 },
        });
      }
      return jsonResult({
        slug,
        path: project.path,
        manualSteps: project.manualSteps,
      });
    }
  );

  server.registerTool(
    "toggle-manual-step",
    {
      title: "Toggle a MANUAL_STEPS.md checkbox",
      description:
        "Flips a single checkbox in <projectPath>/MANUAL_STEPS.md between [ ] and [x]. Uses " +
        "atomic file write (temp + rename) under a file lock. Returns the updated " +
        "ManualStepsInfo so the caller sees the new state.",
      inputSchema: {
        slug: SlugSchema,
        lineNumber: z
          .number()
          .int()
          .min(1)
          .describe("1-based line number of the step (from get-project-manual-steps)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ slug, lineNumber }) => {
      const scan = await getScan();
      const project = scan.projects.find((p) => p.slug === slug);
      if (!project) return errorResult(`No project with slug '${slug}'.`);

      const filePath = path.join(project.path, "MANUAL_STEPS.md");
      try {
        const updated = await toggleStepInFile(filePath, lineNumber);
        return jsonResult({ slug, lineNumber, manualSteps: updated });
      } catch (err) {
        return errorResult(`Failed to toggle step: ${(err as Error).message}`);
      }
    }
  );
}
