import "server-only";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { bridgeDaemonChangeToEventBus } from "./eventBus";
import { toSlug } from "@/lib/scanner/claudeConversations";
import type { JobRosterEntry, JobStateEntry } from "./types";

// Reads ~/.claude/daemon/roster.json + ~/.claude/jobs/<id>/state.json to
// produce the same ground-truth liveness data that Claude Agent View uses.
//
// Schema is undocumented — all fields are treated as optional. We log
// unrecognised shapes at most once per process (gated) but never throw.
//
// Three triggers refresh the cache:
//   1. fs.watch on the daemon dir (change events).
//   2. 5 s mtime sweep (belt-and-braces — Windows fs.watch can miss events).
//   3. On-demand refresh() call from the SSE route on initial connect.

const DAEMON_DIR = path.join(os.homedir(), ".claude", "daemon");
const JOBS_DIR = path.join(os.homedir(), ".claude", "jobs");
const SWEEP_INTERVAL_MS = 5_000;
const DEBOUNCE_MS = 500; // match manualStepsWatcher.ts Windows-dupe pattern

interface RosterState {
  entries: JobRosterEntry[];
  readAt: number;
}

const g = globalThis as unknown as {
  __minderJobRosterState?: RosterState;
  __minderJobRosterWatcher?: import("fs").FSWatcher | null;
  __minderJobRosterSweepTimer?: NodeJS.Timeout | null;
  __minderJobRosterDebounce?: NodeJS.Timeout | null;
  __minderJobRosterLoggedMissing?: boolean;
};

function ensureGlobals(): void {
  g.__minderJobRosterState ??= { entries: [], readAt: 0 };
  g.__minderJobRosterWatcher ??= null;
  g.__minderJobRosterSweepTimer ??= null;
  g.__minderJobRosterDebounce ??= null;
  g.__minderJobRosterLoggedMissing ??= false;
}

export function slugFromPath(projectPath?: string): string {
  if (!projectPath) return "__unknown__";
  return toSlug(path.basename(projectPath));
}

async function readJobState(jobId: string): Promise<JobStateEntry | null> {
  const statePath = path.join(JOBS_DIR, jobId, "state.json");
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return JSON.parse(raw) as JobStateEntry;
  } catch {
    return null;
  }
}

async function buildRoster(): Promise<JobRosterEntry[]> {
  const rosterPath = path.join(DAEMON_DIR, "roster.json");
  let rawRoster: unknown;
  try {
    const text = await fs.readFile(rosterPath, "utf-8");
    rawRoster = JSON.parse(text);
  } catch (err: unknown) {
    // Daemon dir or roster.json not present — normal for users not running claude --bg.
    if (!g.__minderJobRosterLoggedMissing) {
      const isNotFound = err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
      if (!isNotFound) {
        console.warn("[agentView/jobRoster] Failed to read roster.json:", err);
      }
      g.__minderJobRosterLoggedMissing = true;
    }
    return [];
  }

  const rawArray: unknown[] = Array.isArray(rawRoster)
    ? rawRoster
    : rawRoster !== null && typeof rawRoster === "object" && "sessions" in rawRoster
    ? (rawRoster as Record<string, unknown[]>).sessions ?? []
    : [];

  const entries: JobRosterEntry[] = [];
  for (const raw of rawArray) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : String(Date.now());

    // Augment with per-job state.json
    const jobState = await readJobState(id);

    const entry: JobRosterEntry = {
      id,
      slug: typeof r.slug === "string" ? r.slug : undefined,
      sessionId: (typeof r.sessionId === "string" ? r.sessionId : jobState?.sessionId) ?? undefined,
      projectPath: typeof r.projectPath === "string" ? r.projectPath : undefined,
      projectSlug: typeof r.projectSlug === "string"
        ? r.projectSlug
        : slugFromPath(typeof r.projectPath === "string" ? r.projectPath : undefined),
      state: (typeof r.state === "string" ? r.state : jobState?.state) ?? undefined,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : undefined,
      updatedAt: (typeof r.updatedAt === "string" ? r.updatedAt : jobState?.updatedAt) ?? undefined,
      activity: (typeof r.activity === "string" ? r.activity : jobState?.activity) ?? undefined,
      processRunning: typeof r.processRunning === "boolean"
        ? r.processRunning
        : jobState?.processRunning ?? true,
    };

    if (jobState?.awaitingInput) {
      (entry as Record<string, unknown>).awaitingInput = true;
    }
    if (jobState?.model) {
      (entry as Record<string, unknown>).model = jobState.model;
    }

    entries.push(entry);
  }

  return entries;
}

async function refresh(): Promise<void> {
  ensureGlobals();
  const prevEntries = g.__minderJobRosterState!.entries;
  const entries = await buildRoster();

  // Emit daemon-change events for sessions that changed state.
  const prevById = new Map(prevEntries.map((e) => [e.id, e]));
  for (const entry of entries) {
    const prev = prevById.get(entry.id);
    if (!prev || prev.state !== entry.state || prev.updatedAt !== entry.updatedAt) {
      if (entry.sessionId) {
        bridgeDaemonChangeToEventBus(
          entry.sessionId,
          entry.projectSlug ?? "__unknown__",
        );
      }
    }
  }

  g.__minderJobRosterState!.entries = entries;
  g.__minderJobRosterState!.readAt = Date.now();
}

function scheduleDebounce(): void {
  ensureGlobals();
  if (g.__minderJobRosterDebounce) return;
  g.__minderJobRosterDebounce = setTimeout(() => {
    g.__minderJobRosterDebounce = null;
    refresh().catch((err) => console.warn("[agentView/jobRoster] sweep error:", err));
  }, DEBOUNCE_MS);
}

export function getRosterEntries(): JobRosterEntry[] {
  ensureGlobals();
  return g.__minderJobRosterState!.entries;
}

export async function refreshRoster(): Promise<void> {
  await refresh();
}

export function startJobRosterWatcher(): void {
  ensureGlobals();
  if (g.__minderJobRosterWatcher) return;
  if (g.__minderJobRosterSweepTimer) return;

  // Initial load
  refresh().catch(() => {/* daemon dir may not exist yet */});

  // fs.watch on daemon dir (best-effort — dir may not exist)
  fs.access(DAEMON_DIR).then(() => {
    try {
      const watcher = fs.watch(DAEMON_DIR, { recursive: false });
      g.__minderJobRosterWatcher = watcher as unknown as import("fs").FSWatcher;
      // watcher from fs.promises.watch is an AsyncIterable; convert to event listener pattern
      (async () => {
        for await (const _ of watcher) {
          scheduleDebounce();
        }
      })().catch(() => {
        // Watcher died — will be caught by sweep
      });
    } catch {
      // fs.watch not supported or dir disappeared — sweep belt-and-braces covers it
    }
  }).catch(() => {/* DAEMON_DIR doesn't exist — normal for non-agent users */});

  // 5 s sweep
  g.__minderJobRosterSweepTimer = setInterval(() => {
    refresh().catch((err) => console.warn("[agentView/jobRoster] sweep error:", err));
  }, SWEEP_INTERVAL_MS);
  g.__minderJobRosterSweepTimer?.unref?.();
}
