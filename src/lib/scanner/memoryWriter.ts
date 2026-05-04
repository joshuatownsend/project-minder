import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { encodePath } from "./claudeConversations";
import { writeFileAtomic, withFileLock } from "../atomicWrite";
import { isInside } from "../template/pathSafety";

export function memoryDirFor(projectPath: string): string {
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    encodePath(projectPath),
    "memory"
  );
}

export type MemoryWriteError =
  | { code: "INVALID_NAME" }
  | { code: "TRAVERSAL" }
  | { code: "NOT_MARKDOWN" }
  | { code: "WRITE_FAILED"; message: string };

export interface MemoryWriteResult {
  ok: boolean;
  error?: MemoryWriteError;
  bytesWritten?: number;
}

/**
 * Write `content` to `<memoryDir>/<fileName>`, enforcing:
 *   - `fileName` is a non-empty string with no path separators
 *   - basename guard against traversal (`..`, leading `/`)
 *   - extension is `.md`
 *   - target path stays inside the memory dir after canonicalization
 *
 * Creates the memory dir if missing (Claude Code creates it lazily too).
 * Atomic write + per-file lock so a concurrent reader (the dashboard's
 * `scanMemory` poller) can never observe a half-written file.
 */
export async function writeMemoryFile(
  projectPath: string,
  fileName: string,
  content: string
): Promise<MemoryWriteResult> {
  if (!fileName || typeof fileName !== "string") {
    return { ok: false, error: { code: "INVALID_NAME" } };
  }
  // Reject anything with a separator before basename runs — basename would
  // happily strip "/etc/passwd" into "passwd" and silently write a file the
  // caller didn't intend.
  if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("\0")) {
    return { ok: false, error: { code: "TRAVERSAL" } };
  }
  const stripped = path.basename(fileName);
  if (!stripped || stripped === "." || stripped === "..") {
    return { ok: false, error: { code: "TRAVERSAL" } };
  }
  if (!stripped.toLowerCase().endsWith(".md")) {
    return { ok: false, error: { code: "NOT_MARKDOWN" } };
  }

  const memoryDir = memoryDirFor(projectPath);
  const targetPath = path.resolve(memoryDir, stripped);
  if (!isInside(targetPath, path.resolve(memoryDir))) {
    return { ok: false, error: { code: "TRAVERSAL" } };
  }

  try {
    await fs.mkdir(memoryDir, { recursive: true });
    await withFileLock(targetPath, () => writeFileAtomic(targetPath, content));
    return { ok: true, bytesWritten: Buffer.byteLength(content, "utf-8") };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "WRITE_FAILED",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
