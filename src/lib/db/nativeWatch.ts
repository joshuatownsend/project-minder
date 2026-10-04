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
//   - Reads look like writes. On a volume with last-access updates enabled (the
//     Windows default for large volumes: "System Managed"), the OS reports an
//     access-time bump as a `change` just like a write. One full read of the
//     corpus (a history-wide sweep) then queued a no-op reconcile for ~9-13k
//     files and inflated `eventsHandled` (#604, reproduced with `utimes` and a
//     plain `readFileSync`; a bare `stat` does not trigger it). `change` events
//     are therefore gated on the file actually having been written, below.
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
  /**
   * Resolves once every event delivered so far has been judged by the write gate
   * (each `change` is decided by its own asynchronous `stat`). Production never
   * calls this; it exists so a test can assert "nothing was forwarded" without
   * guessing how long the gate takes (a late callback would otherwise be
   * discarded by `close()` and the assertion would pass for the wrong reason).
   */
  settled(): Promise<void>;
}

/**
 * A `change` for a file whose mtime predates the watch by more than this cannot
 * have been caused by a write made while we were watching, so it is an
 * access-time or attribute event. Slack covers clock granularity and the window
 * between the initial reconcile starting and the watch arming (a write in that
 * window has an mtime inside the slack and is let through).
 */
export const WRITE_GATE_SLACK_MS = 5_000;

/** Cap on remembered signatures; cleared wholesale if exceeded (it only dedupes). */
const MAX_REMEMBERED_SIGNATURES = 50_000;

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
  const armedAt = Date.now();
  // Signature (`size:mtime`, in whole ms) of each file we have already passed on, so a read
  // after a write is not mistaken for another write. Only files written during
  // this process's lifetime ever get an entry, so it stays small.
  const passed = new Map<string, string>();
  let closed = false;
  const pending = new Set<Promise<void>>();

  /**
   * Forward a `change` only if the file was actually written. Fails open: if the
   * file cannot be stat'ed, let the caller's own gate decide (a missing file will
   * also have produced a `rename`, and the 30 s sweep is the net for the rest).
   */
  const forwardIfWritten = (filePath: string): void => {
    const judged: Promise<void> = fs.promises.stat(filePath).then(
      (st) => {
        if (closed) return;
        if (st.mtimeMs < armedAt - WRITE_GATE_SLACK_MS) return; // access-time bump on an old file
        // Whole milliseconds: tools that re-set a timestamp go through a `Date`, which
        // drops the sub-millisecond part; a same-size rewrite within one ms is not real.
        const sig = `${st.size}:${Math.floor(st.mtimeMs)}`;
        if (passed.get(filePath) === sig) return; // read after a write we already forwarded
        if (passed.size >= MAX_REMEMBERED_SIGNATURES) passed.clear();
        passed.set(filePath, sig);
        handlers.onChange(filePath);
      },
      () => {
        if (!closed) handlers.onChange(filePath);
      }
    ).then(() => {
      pending.delete(judged);
    });
    pending.add(judged);
  };

  try {
    watcher = fs.watch(root, { recursive: true, persistent: true }, (event, filename) => {
      // `filename` is relative to `root`, and can be null on some platforms.
      // Null or non-transcript events are left to the sweep.
      if (!filename || !filename.toString().endsWith(".jsonl")) return;
      const filePath = path.join(root, filename.toString());
      if (event === "change") {
        forwardIfWritten(filePath);
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
  return {
    close: () => {
      closed = true;
      watcher.close();
    },
    settled: async () => {
      // Events judged while we wait can add more; loop until the set is empty.
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
