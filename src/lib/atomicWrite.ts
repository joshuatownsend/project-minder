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
