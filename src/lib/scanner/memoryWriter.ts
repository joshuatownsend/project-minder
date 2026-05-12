import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { encodePath } from "./claudeConversations";
import { writeFileAtomic, withFileLock, renameWithRetry } from "../atomicWrite";
import { isInside } from "../template/pathSafety";
import {
  parseFrontmatter,
  validateTypedMemory,
  type FrontmatterError,
} from "../memory/memoryFrontmatter";

/** Sub-dir under the memory dir used by Wave M.4 triage actions. */
export const ARCHIVE_SUBDIR = "archive";
export const TRASH_SUBDIR = ".trash";

/** Per the M.4 contract, trashed files are kept locally for 30 days then swept. */
export const TRASH_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

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

/** Result type for the M.4 mover primitives. `destPath` is the post-move absolute path. */
export interface MemoryMoveResult {
  ok: boolean;
  destPath?: string;
  error?:
    | { code: "INVALID_NAME" }
    | { code: "TRAVERSAL" }
    | { code: "NOT_MARKDOWN" }
    | { code: "SOURCE_NOT_FOUND" }
    | { code: "MOVE_FAILED"; message: string };
}

function validateMemoryBasename(fileName: string): { ok: true; stripped: string } | { ok: false; error: MemoryMoveResult["error"] } {
  if (!fileName || typeof fileName !== "string") {
    return { ok: false, error: { code: "INVALID_NAME" } };
  }
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
  return { ok: true, stripped };
}

/**
 * On collision, append a timestamp suffix before `.md` so the prior occupant
 * isn't clobbered. Timestamps are second-resolution (compact ISO) — two
 * back-to-back archives of identically-named files would still race, but
 * the lock around the calling primitive serializes them.
 */
function timestampSuffix(name: string, when: Date = new Date()): string {
  const iso = when.toISOString().replace(/[-:T]/g, "").replace(/\..+$/, "");
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  return `${stem}-${iso}${ext}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a memory file into a sibling subdir of the memory dir — used by the
 * /memory/triage Archive and Delete actions. The mover stays inside the
 * memory dir (path-traversal safe), retries Windows EBUSY via
 * renameWithRetry, and suffixes the destination with a compact ISO
 * timestamp when a same-named file already exists in the subdir.
 */
async function moveMemoryFileTo(
  projectPath: string,
  fileName: string,
  subdir: typeof ARCHIVE_SUBDIR | typeof TRASH_SUBDIR,
): Promise<MemoryMoveResult> {
  const v = validateMemoryBasename(fileName);
  if (!v.ok) return { ok: false, error: v.error };

  const memoryDir = memoryDirFor(projectPath);
  const destDir = path.resolve(memoryDir, subdir);
  if (!isInside(destDir, path.resolve(memoryDir))) {
    return { ok: false, error: { code: "TRAVERSAL" } };
  }

  const srcPath = path.resolve(memoryDir, v.stripped);
  if (!isInside(srcPath, path.resolve(memoryDir))) {
    return { ok: false, error: { code: "TRAVERSAL" } };
  }
  if (!(await pathExists(srcPath))) {
    return { ok: false, error: { code: "SOURCE_NOT_FOUND" } };
  }

  await fs.mkdir(destDir, { recursive: true });
  let destPath = path.join(destDir, v.stripped);
  if (await pathExists(destPath)) {
    destPath = path.join(destDir, timestampSuffix(v.stripped));
  }

  try {
    await withFileLock(srcPath, async () => {
      await renameWithRetry(srcPath, destPath);
    });
    return { ok: true, destPath };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "MOVE_FAILED",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/** Archive: visible non-dot subdir, recoverable via restoreFromSubdir. */
export function archiveMemoryFile(projectPath: string, fileName: string): Promise<MemoryMoveResult> {
  return moveMemoryFileTo(projectPath, fileName, ARCHIVE_SUBDIR);
}

/** Soft-delete: dot-prefixed subdir, swept after 30 days by sweepTrash. */
export function softDeleteMemoryFile(projectPath: string, fileName: string): Promise<MemoryMoveResult> {
  return moveMemoryFileTo(projectPath, fileName, TRASH_SUBDIR);
}

/**
 * Move a file out of archive/ or .trash/ back into the parent memory dir.
 * If a file with that name now occupies the parent, suffix the restored copy.
 */
export async function restoreFromSubdir(
  projectPath: string,
  fileName: string,
  subdir: typeof ARCHIVE_SUBDIR | typeof TRASH_SUBDIR,
): Promise<MemoryMoveResult> {
  const v = validateMemoryBasename(fileName);
  if (!v.ok) return { ok: false, error: v.error };

  const memoryDir = path.resolve(memoryDirFor(projectPath));
  const srcDir = path.resolve(memoryDir, subdir);
  if (!isInside(srcDir, memoryDir)) {
    return { ok: false, error: { code: "TRAVERSAL" } };
  }
  const srcPath = path.resolve(srcDir, v.stripped);
  if (!isInside(srcPath, srcDir)) {
    return { ok: false, error: { code: "TRAVERSAL" } };
  }
  if (!(await pathExists(srcPath))) {
    return { ok: false, error: { code: "SOURCE_NOT_FOUND" } };
  }

  let destPath = path.join(memoryDir, v.stripped);
  if (await pathExists(destPath)) {
    destPath = path.join(memoryDir, timestampSuffix(v.stripped));
  }

  try {
    await withFileLock(srcPath, async () => {
      await renameWithRetry(srcPath, destPath);
    });
    return { ok: true, destPath };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "MOVE_FAILED",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export interface ManagedMemoryFile {
  name: string;
  absPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

async function listSubdir(
  projectPath: string,
  subdir: typeof ARCHIVE_SUBDIR | typeof TRASH_SUBDIR,
): Promise<ManagedMemoryFile[]> {
  const dir = path.join(memoryDirFor(projectPath), subdir);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ManagedMemoryFile[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const abs = path.join(dir, name);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      out.push({ name, absPath: abs, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
    } catch {
      // file vanished between readdir and stat — skip silently
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export function listArchivedMemoryFiles(projectPath: string): Promise<ManagedMemoryFile[]> {
  return listSubdir(projectPath, ARCHIVE_SUBDIR);
}

export function listTrashedMemoryFiles(projectPath: string): Promise<ManagedMemoryFile[]> {
  return listSubdir(projectPath, TRASH_SUBDIR);
}

/**
 * Permanently unlink trashed files older than `maxAgeMs` (default 30d).
 * Best-effort: a single per-file failure does not abort the sweep. Returns
 * the count of files removed.
 */
export async function sweepTrash(
  projectPath: string,
  maxAgeMs: number = TRASH_MAX_AGE_MS,
  now: number = Date.now(),
): Promise<{ removed: number }> {
  const files = await listTrashedMemoryFiles(projectPath);
  let removed = 0;
  for (const f of files) {
    if (now - f.mtimeMs < maxAgeMs) continue;
    try {
      await fs.unlink(f.absPath);
      removed++;
    } catch {
      // best-effort: a locked file or vanished entry isn't worth aborting for
    }
  }
  return { removed };
}
