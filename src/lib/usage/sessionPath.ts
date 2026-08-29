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

// Re-exported rather than redefined (#483). This module and four other sites
// each carried their own copy of the same literal, which is how they all missed
// `agent-<hex>` at once. `parser.ts` re-exports from here, so external callers
// (the `/api/sessions/[sessionId]/*` routes) keep their import path.
import { isValidSessionId, isSubagentSessionId } from "@/lib/sessionId";
export { isValidSessionId };

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
export interface ResolveSessionOptions {
  /**
   * An exact path for this session, from something that already knows one.
   *
   * The index stores `sessions.file_path`, so when the SQL backend is available
   * the answer is a single lookup and the walks below are pure waste (#486).
   * They stay as the fallback: the file backend has no index, and a session
   * written since the last reconcile is not in one.
   *
   * Passed IN rather than looked up here, because `src/lib/usage/` deliberately
   * has no DB dependency. Inverting that to give this function a DB fast path
   * was the other option the issue set out, and it would make the module that
   * the file backend is built on import the database.
   */
  indexedPath?: (sessionId: string) => Promise<string | null>;
}

/**
 * Turn an absolute transcript path into the project directory ingest attributes
 * it to — the segment immediately after `projects/`.
 *
 * Handles both layouts, which is the point: `<projects>/<dir>/<id>.jsonl` and
 * the nested `<projects>/<dir>/<parent>/subagents/<id>.jsonl` both yield
 * `<dir>`. Deriving it from the PATH is what stops a caller re-deriving it from
 * the id and assuming the flat shape (#486).
 */
export function projectDirNameFromPath(filePath: string): string | null {
  const parts = path.resolve(filePath).split(/[\\/]/);
  const i = parts.lastIndexOf("projects");
  if (i < 0 || i + 1 >= parts.length) return null;
  const dir = parts[i + 1];
  return dir && dir.endsWith(".jsonl") ? null : (dir ?? null);
}

export async function resolveSessionJsonl(
  sessionId: string,
  options: ResolveSessionOptions = {},
): Promise<{ filePath: string; projectDirName: string } | null> {
  if (!isValidSessionId(sessionId)) return null;

  // The index first, when a caller supplied one. Exact, one lookup, and it
  // carries the real layout — so nothing downstream has to guess whether the
  // transcript is flat or nested.
  if (options.indexedPath) {
    let hinted: string | null = null;
    try {
      hinted = await options.indexedPath(sessionId);
    } catch {
      // A failing index must not break a lookup the filesystem can still
      // answer. Fall through to the walks.
      hinted = null;
    }
    if (hinted) {
      const dir = projectDirNameFromPath(hinted);
      if (dir) {
        try {
          // Verified, not trusted. The index can lag a deletion, and returning
          // a path that is not there converts "session removed" into an
          // unreadable-file error further down.
          await fs.access(hinted);
          return { filePath: hinted, projectDirName: dir };
        } catch {
          // Indexed but gone. The walks below decide whether it moved.
        }
      }
    }
  }

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
    const root = path.resolve(projectsDir);
    for (const dir of dirs) {
      // Containment barrier (CodeQL js/path-injection): sessionId is already
      // regex-validated and `dir` comes from readdir, but resolve + prefix-
      // check anyway so no combination of inputs can escape the projects dir.
      const candidate = path.resolve(root, dir, `${sessionId}.jsonl`);
      if (!candidate.startsWith(root + path.sep)) continue;
      try {
        await fs.access(candidate);
        return { filePath: candidate, projectDirName: dir };
      } catch {
        // Not in this dir — keep walking.
      }
    }
  }

  // Nested subagent transcripts: `<dir>/<parent-session>/subagents/<id>.jsonl`.
  //
  // Runs only after the flat pass misses, so the common case pays nothing. It
  // has to exist because #483 widened the id gate above to admit `agent-<hex>`,
  // and a gate that admits an id the resolver cannot find just converts
  // "invalid id" into "not found" — every per-session endpoint that resolves
  // through here (`/quality`, `/handoff`, `/context-attribution`, and the
  // network/delegation routes) would still 404 on exactly the sessions the
  // main detail route had just started opening. Raised by both reviewers on
  // PR #484, and correct: the DB path serves detail from indexed columns, but
  // these routes read the transcript off disk.
  //
  // `projectDirName` is the PROJECT directory, not the parent-session
  // directory, matching how ingest attributes these files
  // (`src/lib/db/ingest.ts`) and how `usage/parser.ts` already walks them.
  //
  // Gated on the id shape because this walk is expensive and the miss path is
  // the common one. Measured: 80 project dirs / 3,279 session subdirs, of which
  // 127 hold a `subagents/` directory — so an ungated version put a 1.4s sweep
  // and 3,279 `access` calls in front of every unresolvable id, and timed out a
  // test at 30s under parallel load. See `isSubagentSessionId` for why guessing
  // is safe HERE specifically: being wrong only restores the old behaviour.
  if (!isSubagentSessionId(sessionId)) return null;

  for (const { projectsDir, dirs } of scanned) {
    const root = path.resolve(projectsDir);
    for (const dir of dirs) {
      let sessionDirs: string[];
      try {
        const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
        sessionDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        // Unreadable project dir — the flat pass above already tolerated it.
        continue;
      }
      for (const sessionDir of sessionDirs) {
        const candidate = path.resolve(root, dir, sessionDir, "subagents", `${sessionId}.jsonl`);
        if (!candidate.startsWith(root + path.sep)) continue;
        try {
          await fs.access(candidate);
          return { filePath: candidate, projectDirName: dir };
        } catch {
          // Not here — keep walking.
        }
      }
    }
  }
  return null;
}
