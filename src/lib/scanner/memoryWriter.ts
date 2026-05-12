import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { encodePath } from "./claudeConversations";
import { writeFileAtomic, withFileLock } from "../atomicWrite";
import { isInside } from "../template/pathSafety";
import {
  parseFrontmatter,
  validateTypedMemory,
  type FrontmatterError,
} from "../memory/memoryFrontmatter";

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
  | { code: "WRITE_FAILED"; message: string }
  /** Client-fixable: malformed YAML, unknown type, or prefix↔type mismatch.
   *  Callers mapping to HTTP should return 400 (not 500). */
  | { code: "FRONTMATTER_INVALID"; detail: FrontmatterError };

export interface MemoryWriteResult {
  ok: boolean;
  error?: MemoryWriteError;
  bytesWritten?: number;
}

export interface WriteMemoryOptions {
  /**
   * Skip the prefix↔type frontmatter contract check. Default false (validate).
   * Set true ONLY for callers that intentionally write untyped scratch files
   * -- the production write paths (editor save, seed promote) always validate.
   */
  skipTypeValidation?: boolean;
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
  content: string,
  options: WriteMemoryOptions = {},
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

  if (!options.skipTypeValidation) {
    const parsed = parseFrontmatter(content);
    if ("error" in parsed) {
      return { ok: false, error: { code: "FRONTMATTER_INVALID", detail: parsed.error } };
    }
    const typeErr = validateTypedMemory(stripped, parsed.data);
    if (typeErr) {
      return { ok: false, error: { code: "FRONTMATTER_INVALID", detail: typeErr } };
    }
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
