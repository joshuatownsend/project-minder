import { promises as fs } from "fs";
import path from "path";
import { readConfig } from "@/lib/config";
import { getReadableClaudeHomes } from "@/lib/claudeHome";

// Resolves a session id to the `.jsonl` file Claude Code wrote it into.
//
// Sessions live at `~/.claude/projects/<encoded-project-dir>/<sessionId>.jsonl`.
// The encoded-project-dir piece is content-addressed by Claude Code from the
// project's absolute path (e.g. `C:\dev\project-minder` → `C--dev-project-minder`),
// which means callers that have only the session id but not the project must
// scan every subdirectory to find the matching file.
//
// Three call sites used to inline this fs.walk fallback (parser.ts:622 and 683,
// claudeConversations.ts:502). Extracted here so the validation rules and the
// walk pattern stay in lockstep.

const SESSION_ID_RE = /^[a-f0-9-]+$/i;

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_RE.test(sessionId);
}

/** Walk `<home>/projects/<dir>/<sessionId>.jsonl` across every readable
 *  Claude home (primary + config.claudeHomes) until the first match.
 *  Returns `{ filePath, projectDirName }` on success, `null` when the id is
 *  malformed, no projects directory exists, or no subdir contains a file
 *  with that name.
 *
 *  Error contract: the PRIMARY home keeps the strict behavior (non-ENOENT
 *  listing failures throw — a local EACCES/EIO is a real misconfiguration).
 *  Extra homes are best-effort: an unreachable UNC home (distro just
 *  stopped, network hiccup) must not turn a local session lookup into a 500. */
export async function resolveSessionJsonl(
  sessionId: string,
): Promise<{ filePath: string; projectDirName: string } | null> {
  if (!isValidSessionId(sessionId)) return null;
  const config = await readConfig();
  const homes = await getReadableClaudeHomes(config);

  const scanned: { projectsDir: string; dirs: string[] }[] = [];
  for (const [i, home] of homes.entries()) {
    const projectsDir = path.join(home, "projects");
    try {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      scanned.push({ projectsDir, dirs: entries.filter((e) => e.isDirectory()).map((e) => e.name) });
    } catch (err) {
      if (i === 0 && (err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
  }

  for (const { projectsDir, dirs } of scanned) {
    for (const dir of dirs) {
      const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      try {
        await fs.access(candidate);
        return { filePath: candidate, projectDirName: dir };
      } catch {
        // Not in this dir — keep walking.
      }
    }
  }
  return null;
}
