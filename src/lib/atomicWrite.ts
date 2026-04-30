import { promises as fs } from "fs";
import path from "path";

// Atomic file write + per-file mutex. Used by every writer that touches a
// long-lived file the user (or another reader) might be observing — config,
// TODO.md, MANUAL_STEPS.md, INSIGHTS.md, .claude/settings.json, .mcp.json.
//
// Why the tmp+rename dance:
// - A plain `fs.writeFile` can leave the file half-written if the process
//   crashes (or HMR reloads) mid-flush. A reader that lands during that
//   window sees a corrupted file. `rename` is atomic on Windows and POSIX,
//   so a reader either sees the old file or the new file — never a partial.
// - The tmp suffix includes pid + random bits so two concurrent writers in
//   the same process don't fight over the same tmp path.
//
// Why withFileLock as well:
// - rename atomicity protects byte-level integrity, not logical integrity.
//   If two callers do read→modify→write on the same file in parallel, both
//   read the same starting state and the second write clobbers the first's
//   changes. Per-path mutex ensures read-modify-write cycles serialize.

const fileLocks = new Map<string, Promise<unknown>>();

export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const normalized = path.resolve(filePath);
  const prev = fileLocks.get(normalized) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  fileLocks.set(normalized, next);
  next.finally(() => {
    if (fileLocks.get(normalized) === next) {
      fileLocks.delete(normalized);
    }
  });
  return next;
}

export async function writeFileAtomic(
  filePath: string,
  content: string,
  encoding: BufferEncoding = "utf-8"
): Promise<void> {
  const tmp =
    filePath +
    ".tmp." +
    process.pid +
    "." +
    Math.random().toString(36).slice(2, 8);
  try {
    await fs.writeFile(tmp, content, encoding);
    await fs.rename(tmp, filePath);
  } catch (err) {
    // If rename failed, the tmp file may still be there — best-effort cleanup.
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Rename `src` to `dest`, retrying on Windows EBUSY/EPERM.
 *
 * Why retry? On Windows, file handles release asynchronously after a
 * `close()` (or after a constructor that opened-then-threw). A rename
 * landing within tens of ms of the prior holder's close can fail with
 * EBUSY. POSIX doesn't have this issue but the retry loop is cheap.
 *
 * On a fast path (no contention) the first attempt succeeds. On a slow
 * path the linear backoff caps at ~2.75 s total wait (50ms × 1..10).
 *
 * Errors other than EBUSY/EPERM (most importantly ENOENT) are NOT
 * retried — those are caller bugs, not lock contention.
 */
export async function renameWithRetry(
  src: string,
  dest: string,
  attempts: number = 10
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (i + 1)));
    }
  }
  throw lastErr;
}
