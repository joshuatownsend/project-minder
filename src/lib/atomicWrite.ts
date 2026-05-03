import { promises as fs } from "fs";
import path from "path";
import { AsyncLocalStorage } from "node:async_hooks";

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
//
// Reentrancy:
// - withFileLock is reentrant within a single async chain. The apply layer
//   needs to record a config-history snapshot AND have the apply primitive
//   write the file under one continuous lock — otherwise concurrent applies
//   on the same file can both snapshot the same pre-write bytes, breaking
//   one-step rollback semantics. AsyncLocalStorage tracks which paths the
//   current async context already holds; a re-entrant acquisition skips the
//   queue and just runs the callback directly. Different async chains
//   (independent applies) still serialize as before.
// - Caveat: if you hold lock X and then `await Promise.all([withFileLock(X,
//   ...), withFileLock(X, ...)])`, BOTH inner callbacks take the reentrant
//   fast-path and run concurrently — defeating mutual exclusion within
//   your own chain. Don't do that. Hold the lock once and serialize work
//   yourself, or split into independent chains so the FIFO queue applies.

const fileLocks = new Map<string, Promise<unknown>>();
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const normalized = path.resolve(filePath);
  const heldByMe = heldLocks.getStore();
  if (heldByMe?.has(normalized)) {
    // Re-entrant acquisition in the same async chain — run inline; the
    // outer holder is responsible for serialization against other chains.
    return fn();
  }
  const prev = fileLocks.get(normalized) ?? Promise.resolve();
  const runWithHeld = () => {
    const newHeld = new Set(heldByMe ?? []);
    newHeld.add(normalized);
    return heldLocks.run(newHeld, fn);
  };
  const next = prev.then(runWithHeld, runWithHeld);
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
  content: string | Buffer,
  encoding: BufferEncoding = "utf-8"
): Promise<void> {
  const tmp =
    filePath +
    ".tmp." +
    process.pid +
    "." +
    Math.random().toString(36).slice(2, 8);
  try {
    // Buffer payloads write raw bytes (no transcoding); the encoding arg
    // only applies when content is a string. Restore-from-snapshot relies
    // on this for byte-faithful round-trips of non-UTF-8/binary files.
    if (Buffer.isBuffer(content)) {
      await fs.writeFile(tmp, content);
    } else {
      await fs.writeFile(tmp, content, encoding);
    }
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
