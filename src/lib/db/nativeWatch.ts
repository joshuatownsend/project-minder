import * as fs from "fs";
import path from "path";

// One recursive OS watch over the transcripts tree (#595).
//
// chokidar's non-polling mode attaches a separate `fs.watch` per file and walks
// the whole tree to do it. On Windows that is ~14k handles established one
// `stat` + `watch` at a time, and measured on the live corpus it starved the
// initial reconcile's own I/O: 28.7 s with chokidar off, 21+ minutes with it on.
// `fs.watch(dir, { recursive: true })` is a single ReadDirectoryChangesW handle
// on Windows (FSEvents on macOS): no initial scan, live the moment it returns.
//
// What it does NOT give us, and what covers the gap:
//   - Events are not guaranteed (buffer overflow under a burst, a directory
//     removed wholesale). The 30 s mtime sweep in `ingestWatcher` is the safety
//     net, exactly as it was for chokidar.
//   - No add/change/unlink distinction: `rename` means "something appeared or
//     went away", so we `stat` to find out which.
//   - No `awaitWriteFinish`. The caller's per-file debounce coalesces bursts, and
//     the reconcile already tolerates a half-written trailing line (the sweep
//     reads files with no stability gate at all).

export interface NativeWatchHandlers {
  /** A `.jsonl` was created or modified (or may have been: the caller re-gates it). */
  onChange(filePath: string): void;
  /** A `.jsonl` named by a `rename` event no longer exists. */
  onGone(filePath: string): void;
  /** The watch itself failed after starting. Nothing further will be delivered. */
  onError(err: Error): void;
}

export interface NativeWatch {
  close(): void;
}

/**
 * Start the watch, or return `null` when it cannot be established (the root is
 * missing, or recursive watching is unsupported here). Never throws: the caller
 * falls back to chokidar, which also copes with a root that appears later.
 */
export function startNativeRecursiveWatch(
  root: string,
  handlers: NativeWatchHandlers
): NativeWatch | null {
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(root, { recursive: true, persistent: true }, (event, filename) => {
      // `filename` is relative to `root`, and can be null on some platforms.
      // Null or non-transcript events are left to the sweep.
      if (!filename || !filename.toString().endsWith(".jsonl")) return;
      const filePath = path.join(root, filename.toString());
      if (event === "change") {
        handlers.onChange(filePath);
        return;
      }
      // `rename`: appeared or vanished. Deletion triggers a full prune pass, so
      // decide by looking rather than guessing.
      fs.promises.stat(filePath).then(
        () => handlers.onChange(filePath),
        (err: NodeJS.ErrnoException) => {
          if (err?.code === "ENOENT") handlers.onGone(filePath);
          // Anything else (EBUSY mid-write, EPERM): the sweep will see the file.
        }
      );
    });
  } catch {
    return null;
  }
  watcher.on("error", (err) => handlers.onError(err));
  return { close: () => watcher.close() };
}
