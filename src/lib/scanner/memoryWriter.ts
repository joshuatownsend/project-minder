import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { encodePath } from "./claudeConversations";
import { writeFileAtomic, withFileLock, renameWithRetry } from "../atomicWrite";
import { isInside } from "../template/pathSafety";
import { recordPreWrite } from "../configHistory";
import {
  parseFrontmatter,
  validateTypedMemory,
  type FrontmatterError,
} from "../memory/memoryFrontmatter";

export const MAX_BYTES = 2 * 1024 * 1024;

export const ARCHIVE_SUBDIR = "archive";
/** Dot-prefix keeps the main scanner's `!n.startsWith(".")` filter from
 *  bleeding trashed files into the live /memory listing. */
export const TRASH_SUBDIR = ".trash";
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
  | { code: "FRONTMATTER_INVALID"; detail: FrontmatterError }
  | { code: "TOO_LARGE" }
  | { code: "MTIME_CONFLICT" };

export interface MemoryWriteResult {
  ok: boolean;
  error?: MemoryWriteError;
  bytesWritten?: number;
  mtimeMs?: number;
  sizeBytes?: number;
  backupId?: string | null;
}

export interface WriteMemoryOptions {
  /**
   * Skip the prefix↔type frontmatter contract check. Default false (validate).
   * Set true ONLY for callers that intentionally write untyped scratch files
   * -- the production write paths (editor save, seed promote) always validate.
   */
  skipTypeValidation?: boolean;
  /**
   * When set, the write fails with MTIME_CONFLICT if the file's current mtime
   * differs by more than 1ms from this value. Pass 0 to assert the file does
   * not exist yet. Omit to skip the check (last-write-wins).
   */
  expectedMtimeMs?: number;
  /** Label used when recording the pre-write backup. Defaults to "memoryEditor". */
  backupLabel?: string;
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
  const v = validateMemoryBasename(fileName);
  if (!v.ok) return { ok: false, error: v.error };
  const stripped = v.stripped;

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

  const contentBytes = Buffer.byteLength(content, "utf-8");
  if (contentBytes > MAX_BYTES) {
    return { ok: false, error: { code: "TOO_LARGE" } };
  }

  const memoryDirAbs = path.resolve(memoryDirFor(projectPath));
  const targetPath = path.resolve(memoryDirAbs, stripped);
  if (!isInside(targetPath, memoryDirAbs)) {
    return { ok: false, error: { code: "TRAVERSAL" } };
  }

  try {
    await fs.mkdir(memoryDirAbs, { recursive: true });
    return await withFileLock(targetPath, async (): Promise<MemoryWriteResult> => {
      if (options.expectedMtimeMs !== undefined) {
        let currentMtime: number | null = null;
        try {
          const s = await fs.stat(targetPath);
          currentMtime = s.mtimeMs;
        } catch (statErr) {
          if ((statErr as NodeJS.ErrnoException).code !== "ENOENT") throw statErr;
          if (options.expectedMtimeMs !== 0) {
            return { ok: false, error: { code: "MTIME_CONFLICT" } };
          }
        }
        if (currentMtime !== null && Math.abs(currentMtime - options.expectedMtimeMs) > 1) {
          return { ok: false, error: { code: "MTIME_CONFLICT" } };
        }
      }

      let backupId: string | null = null;
      try {
        backupId = await recordPreWrite(targetPath, {
          label: options.backupLabel ?? "memoryEditor",
        });
      } catch {
        // backup is best-effort; do not block the save
      }

      await writeFileAtomic(targetPath, content);

      const newStat = await fs.stat(targetPath);
      return {
        ok: true,
        bytesWritten: contentBytes,
        mtimeMs: newStat.mtimeMs,
        sizeBytes: newStat.size,
        backupId,
      };
    });
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
  error?: BasenameError | { code: "SOURCE_NOT_FOUND" } | { code: "MOVE_FAILED"; message: string };
}

type BasenameError =
  | { code: "INVALID_NAME" }
  | { code: "TRAVERSAL" }
  | { code: "NOT_MARKDOWN" };

/**
 * Shared basename guard used by `writeMemoryFile` and every mover primitive.
 * Centralizing prevents drift if the rules ever evolve (e.g. length caps,
 * Windows-reserved names). The error variants are a subset of every caller's
 * error union so the result is structurally assignable in both directions.
 */
function validateMemoryBasename(
  fileName: string,
): { ok: true; stripped: string } | { ok: false; error: BasenameError } {
  if (!fileName || typeof fileName !== "string") {
    return { ok: false, error: { code: "INVALID_NAME" } };
  }
  // basename would happily strip "/etc/passwd" into "passwd" — reject pre-strip.
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
 * Atomic rename + collision-suffix engine shared by the move-IN (archive,
 * soft-delete) and move-OUT (restore-from-archive, restore-from-trash) paths.
 * Path-traversal safe (target stays inside the memory dir), retries Windows
 * EBUSY via renameWithRetry, and suffixes the destination with a compact ISO
 * timestamp when a same-named file already exists.
 *
 * Locks the destination dir for the existence-check + suffix + rename step
 * so two concurrent moves into the same dir can't both decide on the same
 * `destPath` between `pathExists` and `rename` (POSIX rename silently
 * overwrites; without the lock the second mover clobbers the first).
 *
 * `refreshMtime: true` is used by soft-delete so the trash sweep's age
 * window starts at deletion time rather than the source file's original
 * mtime. Without it, a memory edited >30d ago and soft-deleted right now
 * would be permanently unlinked on the very next sweep.
 *
 * Source presence is NOT pre-checked — renameWithRetry surfaces ENOENT and
 * we map it in the catch so there's no TOCTOU window between stat and rename.
 */
async function renameInsideMemoryDir(
  memoryDirAbs: string,
  srcDir: string,
  destDir: string,
  basename: string,
  refreshMtime: boolean = false,
): Promise<MemoryMoveResult> {
  if (!isInside(srcDir, memoryDirAbs) || !isInside(destDir, memoryDirAbs)) {
    return { ok: false, error: { code: "TRAVERSAL" } };
  }
  const srcPath = path.resolve(srcDir, basename);
  if (!isInside(srcPath, srcDir)) {
    return { ok: false, error: { code: "TRAVERSAL" } };
  }

  await fs.mkdir(destDir, { recursive: true });

  try {
    const destPath = await withFileLock(destDir, async () => {
      let chosen = path.join(destDir, basename);
      if (await pathExists(chosen)) {
        chosen = path.join(destDir, timestampSuffix(basename));
      }
      await withFileLock(srcPath, () => renameWithRetry(srcPath, chosen));
      if (refreshMtime) {
        const now = new Date();
        try {
          await fs.utimes(chosen, now, now);
        } catch {
          // best-effort: a failed utimes shouldn't fail the whole move
        }
      }
      return chosen;
    });
    return { ok: true, destPath };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, error: { code: "SOURCE_NOT_FOUND" } };
    }
    return {
      ok: false,
      error: {
        code: "MOVE_FAILED",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function moveMemoryFileTo(
  projectPath: string,
  fileName: string,
  subdir: typeof ARCHIVE_SUBDIR | typeof TRASH_SUBDIR,
): Promise<MemoryMoveResult> {
  const v = validateMemoryBasename(fileName);
  if (!v.ok) return { ok: false, error: v.error };
  const memoryDirAbs = path.resolve(memoryDirFor(projectPath));
  return renameInsideMemoryDir(
    memoryDirAbs,
    memoryDirAbs,
    path.resolve(memoryDirAbs, subdir),
    v.stripped,
    subdir === TRASH_SUBDIR,
  );
}

async function restoreFromSubdir(
  projectPath: string,
  fileName: string,
  subdir: typeof ARCHIVE_SUBDIR | typeof TRASH_SUBDIR,
): Promise<MemoryMoveResult> {
  const v = validateMemoryBasename(fileName);
  if (!v.ok) return { ok: false, error: v.error };
  const memoryDirAbs = path.resolve(memoryDirFor(projectPath));
  return renameInsideMemoryDir(
    memoryDirAbs,
    path.resolve(memoryDirAbs, subdir),
    memoryDirAbs,
    v.stripped,
  );
}

/** Archive: visible non-dot subdir; reversible via restoreFromArchive. */
export function archiveMemoryFile(projectPath: string, fileName: string): Promise<MemoryMoveResult> {
  return moveMemoryFileTo(projectPath, fileName, ARCHIVE_SUBDIR);
}

/** Soft-delete: dot-prefixed subdir, swept after 30 days. */
export function softDeleteMemoryFile(projectPath: string, fileName: string): Promise<MemoryMoveResult> {
  return moveMemoryFileTo(projectPath, fileName, TRASH_SUBDIR);
}

export function restoreFromArchive(projectPath: string, fileName: string): Promise<MemoryMoveResult> {
  return restoreFromSubdir(projectPath, fileName, ARCHIVE_SUBDIR);
}

export function restoreFromTrash(projectPath: string, fileName: string): Promise<MemoryMoveResult> {
  return restoreFromSubdir(projectPath, fileName, TRASH_SUBDIR);
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
 * One-pass sweep + survivor list. Folds together the "permanently unlink
 * files older than `maxAgeMs`" pass and the "give me the remaining trash for
 * display" pass so the triage GET handler doesn't readdir `.trash/` twice
 * per project on every page load. Best-effort: a single per-file unlink
 * failure does not abort the sweep.
 */
export async function sweepAndListTrash(
  projectPath: string,
  maxAgeMs: number = TRASH_MAX_AGE_MS,
  now: number = Date.now(),
): Promise<{ removed: number; survivors: ManagedMemoryFile[] }> {
  const files = await listTrashedMemoryFiles(projectPath);
  const survivors: ManagedMemoryFile[] = [];
  let removed = 0;
  for (const f of files) {
    if (now - f.mtimeMs < maxAgeMs) {
      survivors.push(f);
      continue;
    }
    try {
      await fs.unlink(f.absPath);
      removed++;
    } catch {
      // file is locked or already gone — keep showing it; next sweep retries
      survivors.push(f);
    }
  }
  return { removed, survivors };
}

/** Back-compat wrapper for callers that only want the unlink pass. */
export async function sweepTrash(
  projectPath: string,
  maxAgeMs: number = TRASH_MAX_AGE_MS,
  now: number = Date.now(),
): Promise<{ removed: number }> {
  const { removed } = await sweepAndListTrash(projectPath, maxAgeMs, now);
  return { removed };
}
