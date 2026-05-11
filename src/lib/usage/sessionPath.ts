import { promises as fs } from "fs";
import os from "os";
import path from "path";

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

/** Walk `~/.claude/projects/<dir>/<sessionId>.jsonl` until the first match.
 *  Returns `{ filePath, projectDirName }` on success, `null` when the id is
 *  malformed, the projects directory doesn't exist, or no subdir contains
 *  a file with that name. */
export async function resolveSessionJsonl(
  sessionId: string,
): Promise<{ filePath: string; projectDirName: string } | null> {
  if (!isValidSessionId(sessionId)) return null;
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
  for (const dir of dirs) {
    const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    try {
      await fs.access(candidate);
      return { filePath: candidate, projectDirName: dir };
    } catch {
      // Not in this dir — keep walking.
    }
  }
  return null;
}
