import "server-only";
import { getDb } from "@/lib/db/connection";
import {
  aggregateGitActivity,
  type GitActivitySummary,
} from "@/lib/usage/gitActivity";
import { parseAllSessions, canonicalizeDirName } from "@/lib/usage/parser";
import { gatherProjectTurns, projectDirNameCandidates } from "@/lib/usage/projectMatch";
import { readConfig } from "@/lib/config";
import { getClaudeHomes } from "@/lib/claudeHome";
import { toSlug } from "@/lib/scanner/claudeConversations";

// Composed lookup for "git activity by project slug + path". Used by the
// /api/projects/[slug]/git-activity route AND the MCP `get-project-git-activity`
// tool. Picks DB path when available (single join over tool_uses + sessions),
// falls back to file-parse otherwise.
export async function getProjectGitActivity(
  slug: string,
  projectPath: string
): Promise<GitActivitySummary> {
  const cfg = await readConfig();
  const mappings = cfg.pathMappings ?? [];
  const homes = getClaudeHomes(cfg);
  // DB rows for WSL sessions carry the FOREIGN-derived project_slug (the
  // ingest parser slugs the encoded Linux dirname, e.g. `-home-josh-dev-foo`
  // → `home-josh-dev-foo`), so querying by the scanned route slug alone
  // returns nothing for a UNC project. Query every candidate slug — derived
  // exactly the way ingest derives it (toSlug ∘ canonicalizeDirName).
  const slugCandidates = [
    ...new Set([
      slug,
      ...projectDirNameCandidates(projectPath, mappings, homes).map((c) =>
        toSlug(canonicalizeDirName(c.dirName))
      ),
    ]),
  ];
  const placeholders = slugCandidates.map(() => "?").join(", ");

  const db = await getDb();
  if (db) {
    try {
      type ToolRow = { arguments_json: string | null };
      type BranchRow = { git_branch: string | null; end_ts: string | null };
      const toolRows = db
        .prepare(
          `SELECT tu.arguments_json FROM tool_uses tu
           JOIN sessions s ON tu.session_id = s.session_id
           WHERE s.project_slug IN (${placeholders}) AND tu.tool_name IN ('Bash', 'PowerShell')`
        )
        .all(...slugCandidates) as ToolRow[];
      const branchRows = db
        .prepare(`SELECT git_branch, end_ts FROM sessions WHERE project_slug IN (${placeholders})`)
        .all(...slugCandidates) as BranchRow[];

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
  const projectTurns = gatherProjectTurns(sessionMap, slug, projectPath, mappings, homes);
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
