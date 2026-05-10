import path from "path";
import os from "os";
import type { ProjectData } from "../types";
import { memoryDirFor } from "../scanner/memoryWriter";

// PUT to /api/memory/by-id/[id] decodes its `id` into an absolute path. Without
// an allowlist, that becomes a write-anywhere primitive. We constrain accepted
// targets to exactly three shapes:
//   1. The user-scope CLAUDE.md (`~/.claude/CLAUDE.md`)
//   2. A scanned project's CLAUDE.md (`<project.path>/CLAUDE.md`)
//   3. An auto-memory file inside `~/.claude/projects/<encoded>/memory/*.md`
// Anything else — including ".." escapes that resolve back into the tree —
// gets a 400 PATH_NOT_ALLOWED before any snapshot or write happens.

export function userMemoryPath(): string {
  return path.resolve(path.join(os.homedir(), ".claude", "CLAUDE.md"));
}

export function projectMemoryPath(projectPath: string): string {
  return path.resolve(path.join(projectPath, "CLAUDE.md"));
}

export function decodeMemoryId(id: string): string | null {
  try {
    const decoded = Buffer.from(id, "base64url").toString("utf-8");
    if (!decoded || decoded.includes("\0")) return null;
    if (!path.isAbsolute(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function encodeMemoryId(absPath: string): string {
  return Buffer.from(absPath, "utf-8").toString("base64url");
}

export interface AllowedPathInfo {
  scope: "user" | "project" | "auto";
  projectSlug?: string;
  projectPath?: string;
}

/** Validate `absPath` against the three allowed shapes and return scope info,
 *  or null if disallowed. Pure: caller passes the project list it already has
 *  (from `scanAllProjects()`), so we don't introduce a scan dependency here. */
export function classifyMemoryPath(
  absPath: string,
  projects: ProjectData[],
): AllowedPathInfo | null {
  const resolved = path.resolve(absPath);

  // 1. User scope
  if (resolved === userMemoryPath()) {
    return { scope: "user" };
  }

  for (const p of projects) {
    // 2. Project CLAUDE.md
    if (resolved === projectMemoryPath(p.path)) {
      return { scope: "project", projectSlug: p.slug, projectPath: p.path };
    }

    // 3. Auto-memory inside this project's memory dir
    const memDir = path.resolve(memoryDirFor(p.path));
    if (
      path.dirname(resolved) === memDir &&
      resolved.toLowerCase().endsWith(".md") &&
      !path.basename(resolved).startsWith(".")
    ) {
      return { scope: "auto", projectSlug: p.slug, projectPath: p.path };
    }
  }

  return null;
}
