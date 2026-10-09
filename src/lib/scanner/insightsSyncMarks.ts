import { promises as fs, mkdirSync, renameSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { withFileLock, writeFileAtomic } from "../atomicWrite";
import { normalizePathKey } from "../platform";

// #612 — when each project's insights were last synced from session transcripts. INSIGHTS.md's mtime
// only moves when something NEW is written, so alone it leaves the watermark stale for a project that
// has nothing new (or no INSIGHTS.md at all) and every scan re-reads its newer transcripts.
// Best-effort: a missing, corrupt or unwritable file just means the old (slower) behaviour.

export interface SyncMark {
  /** Wall-clock ms at which the sync that recorded this mark STARTED (files written during it are re-read once). */
  at: number;
  /** Whether INSIGHTS.md existed when the sync finished. A mark made WITH one stops applying if the file is later deleted; a mark made without one stays valid while the file is absent. */
  hadFile: boolean;
  /** The transcript directories this sync saw; one not listed here is new since, and is read in full. */
  dirs: string[];
}

interface MarksState {
  marks: Map<string, SyncMark>;
  loaded: Promise<void>;
  file: string;
  timer: NodeJS.Timeout | null;
}

const FILE_VERSION = 1;
const FLUSH_DELAY_MS = 2000;
const FUTURE_TOLERANCE_MS = 60_000;
const g = globalThis as unknown as { __minderInsightsMarks?: MarksState };

function marksFile(): string {
  return path.join(process.env.MINDER_STATE_DIR || path.join(os.homedir(), ".minder"), "insights-sync.json");
}

function keyFor(projectPath: string): string {
  return normalizePathKey(path.resolve(projectPath));
}

function isMark(v: unknown): v is SyncMark {
  const m = v as Partial<SyncMark> | null;
  return (
    !!m && typeof m.at === "number" && Number.isFinite(m.at) && typeof m.hadFile === "boolean" &&
    Array.isArray(m.dirs) && m.dirs.every((d) => typeof d === "string")
  );
}

function getState(): MarksState {
  const file = marksFile();
  // Re-created when the state dir changes (tests point MINDER_STATE_DIR at a temp directory per case).
  if (g.__minderInsightsMarks && g.__minderInsightsMarks.file === file) return g.__minderInsightsMarks;
  const marks = new Map<string, SyncMark>();
  const state: MarksState = {
    marks,
    file,
    timer: null,
    loaded: (async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as { version?: number; marks?: Record<string, unknown> };
        if (parsed.version !== FILE_VERSION || !parsed.marks) return;
        for (const [k, v] of Object.entries(parsed.marks)) if (isMark(v)) marks.set(k, v);
      } catch {
        // no file yet, or unreadable: start empty
      }
    })(),
  };
  g.__minderInsightsMarks = state;
  return state;
}

export async function getSyncMark(projectPath: string): Promise<SyncMark | undefined> {
  const state = getState();
  await state.loaded;
  return state.marks.get(keyFor(projectPath));
}

export function setSyncMark(projectPath: string, mark: SyncMark): void {
  const state = getState();
  const key = keyFor(projectPath);
  // Monotonic: overlapping scan generations can finish out of order, and the older one must not
  // move a newer mark back (that would re-read the range the newer one already covered).
  const existing = state.marks.get(key);
  // A future-dated existing mark is one watermarkFor already ignores, so it must not block its replacement.
  if (effectiveMark(existing) && existing!.at > mark.at) return;
  state.marks.set(key, mark);
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    // The state may have been replaced since (state dir changed): flush only if it is still the live one.
    if (g.__minderInsightsMarks === state) void flushSyncMarks();
  }, FLUSH_DELAY_MS);
  state.timer.unref?.();
}

/**
 * Write the marks to disk now, synchronously and without ever throwing. For shutdown: the lifecycle
 * treats a disposer that fails or overruns its (small) budget as an unconfirmed stop and withholds
 * the database's clean-shutdown marker, so best-effort cache persistence must be instant and silent.
 */
export function flushSyncMarksSync(): void {
  const state = g.__minderInsightsMarks;
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  try {
    mkdirSync(path.dirname(state.file), { recursive: true });
    const tmp = `${state.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, marks: Object.fromEntries(state.marks) }));
    renameSync(tmp, state.file);
  } catch {
    // best-effort
  }
}

/** Write the marks to disk now. Best-effort. */
export async function flushSyncMarks(): Promise<void> {
  const state = g.__minderInsightsMarks;
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  try {
    await state.loaded;
    await fs.mkdir(path.dirname(state.file), { recursive: true });
    await withFileLock(state.file, () =>
      writeFileAtomic(state.file, JSON.stringify({ version: FILE_VERSION, marks: Object.fromEntries(state.marks) })),
    );
  } catch {
    // best-effort
  }
}

/**
 * A mark from the future (clock set back, hand-edited file) would hide every normally timestamped
 * transcript until the clock catches up; it is ignored rather than trusted.
 */
export function effectiveMark(mark: SyncMark | undefined, now: number = Date.now()): SyncMark | undefined {
  return mark && mark.at <= now + FUTURE_TOLERANCE_MS ? mark : undefined;
}

/**
 * The time before which session files can be skipped.
 * `insightsMtimeMs` is INSIGHTS.md's mtime, or null when the file does not exist.
 */
export function watermarkFor(
  insightsMtimeMs: number | null,
  rawMark: SyncMark | undefined,
  now: number = Date.now(),
): number {
  const mark = effectiveMark(rawMark, now);
  if (insightsMtimeMs === null) {
    // No file. A mark recorded when there was none says "scanned everything, found nothing":
    // trust it. A mark recorded WITH a file means it was deleted since, so start over.
    return mark && !mark.hadFile ? mark.at : 0;
  }
  // File exists: an edit or append is itself a sync point, so never go earlier than its mtime.
  return Math.max(insightsMtimeMs, mark?.at ?? 0);
}
