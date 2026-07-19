import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { ProjectData } from "../types";
import { memoryDirFor } from "../scanner/memoryWriter";
import { checkWslRoot, parseWslUncPath } from "../wsl";

// PUT to /api/memory/by-id/[id] decodes its `id` into an absolute path. Without
// an allowlist, that becomes a write-anywhere primitive. We constrain accepted
// targets to exactly three shapes:
//   1. The user-scope CLAUDE.md (~/.claude/CLAUDE.md)
//   2. A scanned project's CLAUDE.md (<project.path>/CLAUDE.md)
//   3. An auto-memory file inside ~/.claude/projects/<encoded>/memory/*.md
// Both candidate and allowlist entries are realpath-resolved so a symlink
// in the home dir or project root cannot fool the comparison. Anything else
// (including ".." escapes that resolve back into the tree) gets a 400
// PATH_NOT_ALLOWED before any snapshot or write happens.

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

// Realpath the candidate. If the file doesn't exist (allowed for the
// mtimeMs=0 create-via-PUT escape hatch), realpath the parent directory and
// re-attach the basename, so we still resolve any symlinks in the parent
// chain. Returns null only on truly missing parent dirs.
async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    try {
      const parentReal = await fs.realpath(path.dirname(p));
      return path.join(parentReal, path.basename(p));
    } catch {
      return null;
    }
  }
}

export async function classifyMemoryPath(
  absPath: string,
  projects: ProjectData[],
): Promise<AllowedPathInfo | null> {
  // Never-wake preflight: the candidate is user-supplied (decoded memory id),
  // so realpath'ing it while its WSL distro is stopped would auto-start the
  // VM. Refuse to classify — the caller treats null as "not allowed".
  if (parseWslUncPath(absPath)) {
    const check = await checkWslRoot(absPath);
    if (check && !check.ok) return null;
  }

  const realCandidate = await safeRealpath(absPath);
  if (!realCandidate) return null;

  const realUser = await safeRealpath(userMemoryPath());
  if (realUser && realCandidate === realUser) {
    return { scope: "user" };
  }

  for (const p of projects) {
    // Never-wake preflight for the project-scope half only: realpath'ing
    // <p.path>/CLAUDE.md under a stopped WSL distro would auto-start its VM.
    // The auto-scope half below stays active — memoryDirFor(p.path) derives a
    // LOCAL ~/.claude path from the path string, so managing a stopped-WSL
    // project's auto memories (which live locally) keeps working.
    let projectMdBlocked = false;
    if (parseWslUncPath(p.path)) {
      const check = await checkWslRoot(p.path);
      projectMdBlocked = check !== null && !check.ok;
    }
    if (!projectMdBlocked) {
      const realProjectMd = await safeRealpath(projectMemoryPath(p.path));
      if (realProjectMd && realCandidate === realProjectMd) {
        return { scope: "project", projectSlug: p.slug, projectPath: p.path };
      }
    }

    const realMemDir = await safeRealpath(memoryDirFor(p.path));
    if (
      realMemDir &&
      path.dirname(realCandidate) === realMemDir &&
      realCandidate.toLowerCase().endsWith(".md") &&
      !path.basename(realCandidate).startsWith(".")
    ) {
      return { scope: "auto", projectSlug: p.slug, projectPath: p.path };
    }
  }

  return null;
}
