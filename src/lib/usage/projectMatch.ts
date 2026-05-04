import type { UsageTurn } from "./types";

/**
 * Convert a Windows or POSIX project path to the canonical dirname
 * Claude Code uses under `~/.claude/projects/`. The encoding rule:
 * `:`, `\`, and `.` all become `-`. Used to match parser-produced
 * `projectDirName` exactly to a scanned project.
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[:\\.]/g, "-");
}

/**
 * Collect all UsageTurns that belong to a given project from the full
 * session map. Matches on exact slug equality OR exact encoded-dirname
 * equality to avoid substring false-positives (e.g. slug "api" matching
 * "my-api-server"). Per-session early-out: every turn in a session shares
 * the same projectSlug + projectDirName, so checking the first turn avoids
 * walking the rest for non-matching sessions.
 */
export function gatherProjectTurns(
  sessionMap: Map<string, UsageTurn[]>,
  slug: string,
  projectPath: string
): UsageTurn[] {
  const expectedDirName = encodeProjectPath(projectPath);
  const result: UsageTurn[] = [];
  for (const turns of sessionMap.values()) {
    if (turns.length === 0) continue;
    const head = turns[0];
    if (head.projectSlug !== slug && head.projectDirName !== expectedDirName) continue;
    for (const t of turns) result.push(t);
  }
  return result;
}
