import "server-only";
import { getDb } from "@/lib/db/connection";
import {
  aggregateGitActivity,
  type GitActivitySummary,
} from "@/lib/usage/gitActivity";
import { parseAllSessions } from "@/lib/usage/parser";
import { gatherProjectTurns } from "@/lib/usage/projectMatch";
import { readConfig } from "@/lib/config";

// Composed lookup for "git activity by project slug + path". Used by the
// /api/projects/[slug]/git-activity route AND the MCP `get-project-git-activity`
// tool. Picks DB path when available (single join over tool_uses + sessions),
// falls back to file-parse otherwise.
export async function getProjectGitActivity(
  slug: string,
  projectPath: string
): Promise<GitActivitySummary> {
  const db = await getDb();
  if (db) {
    try {
      type ToolRow = { arguments_json: string | null };
      type BranchRow = { git_branch: string | null; end_ts: string | null };
      const toolRows = db
        .prepare(
          `SELECT tu.arguments_json FROM tool_uses tu
           JOIN sessions s ON tu.session_id = s.session_id
           WHERE s.project_slug = ? AND tu.tool_name IN ('Bash', 'PowerShell')`
        )
        .all(slug) as ToolRow[];
      const branchRows = db
        .prepare(`SELECT git_branch, end_ts FROM sessions WHERE project_slug = ?`)
        .all(slug) as BranchRow[];

      const toolCommands = toolRows.map((r) => {
        try {
          return {
            command:
              ((JSON.parse(r.arguments_json ?? "{}") as Record<string, unknown>)
                ?.command as string) ?? "",
          };
        } catch {
          return { command: "" };
        }
      });
      const sessionBranches = branchRows.map((r) => ({
        branch: r.git_branch,
        lastActivity: r.end_ts ?? "",
      }));
      return aggregateGitActivity(toolCommands, sessionBranches);
    } catch {
      // Fall through to file-parse path on any DB schema mismatch.
    }
  }

  // File-parse fallback: commands only, no branch info — UsageTurn doesn't
  // carry git_branch the way the DB sessions row does.
  const sessionMap = await parseAllSessions();
  const projectTurns = gatherProjectTurns(
    sessionMap, slug, projectPath, (await readConfig()).pathMappings ?? []
  );
  const toolCommands = projectTurns.flatMap((t) =>
    t.toolCalls
      .filter((tc) => tc.name === "Bash" || tc.name === "PowerShell")
      .map((tc) => ({
        command:
          (tc.arguments?.command as string | undefined) ??
          (tc.arguments?.script as string | undefined) ??
          "",
      }))
  );
  return aggregateGitActivity(toolCommands, []);
}
