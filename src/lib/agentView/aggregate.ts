import "server-only";
import { getLiveStatusPayload } from "@/lib/liveStatus";
import { sweepAndGetState, getHookBuffer, STOP_EVENTS } from "@/lib/hooks/buffer";
import { getRosterEntries } from "./jobRoster";
import type { LiveAgentSession, AgentSessionStatus } from "./types";
import { STATUS_ORDER } from "./types";
import type { LiveSessionStatus } from "@/lib/types";

// Merges three data sources into a single LiveAgentSession[]:
//   1. Daemon roster (authoritative for `claude --bg` sessions)
//   2. Hook buffer ring (precise for hook-enabled foreground sessions)
//   3. JSONL liveStatus (fallback for all sessions)
//
// The abandoned-reaper drops sessions silent for longer than abandonThresholdMin.

const DEFAULT_ABANDON_MIN = 180;

export function liveStatusToAgentStatus(s: LiveSessionStatus): AgentSessionStatus {
  if (s === "working") return "working";
  if (s === "approval" || s === "waiting") return "waiting";
  return "idle";
}

export function daemonStateToAgentStatus(state?: string): AgentSessionStatus {
  if (!state) return "working";
  const s = state.toLowerCase();
  if (s === "completed") return "completed";
  if (s === "failed" || s === "error") return "failed";
  if (s === "stopped") return "stopped";
  if (s === "waiting" || s === "awaiting_input") return "waiting";
  if (s === "idle") return "idle";
  return "working";
}

function truncate(s: string | undefined, max = 80): string | undefined {
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export async function aggregateLiveSessions(
  abandonThresholdMin = DEFAULT_ABANDON_MIN,
): Promise<LiveAgentSession[]> {
  const now = Date.now();
  const abandonThresholdMs = abandonThresholdMin * 60_000;

  // Source 1: daemon roster
  const rosterEntries = getRosterEntries();
  const rosterBySessionId = new Map(
    rosterEntries.filter((e) => e.sessionId).map((e) => [e.sessionId!, e]),
  );

  // Source 2: hook buffer (live hook events, hook-gated)
  const { liveSlugs, awaitingSlugs } = sweepAndGetState();
  const liveSlugSet = new Set(liveSlugs);
  const awaitingSlugSet = new Set(awaitingSlugs);

  // Source 3: JSONL live status (always available)
  const { sessions: jsonlSessions } = await getLiveStatusPayload();

  const result = new Map<string, LiveAgentSession>();

  // Roster sessions are authoritative — add them first.
  for (const entry of rosterEntries) {
    const sessionId = entry.sessionId ?? entry.id;
    const slug = entry.projectSlug ?? "__unknown__";
    const lastChangedAt = entry.updatedAt ?? entry.createdAt ?? new Date().toISOString();
    const lastMs = new Date(lastChangedAt).getTime();
    const secondsSinceChange = Math.floor((now - lastMs) / 1000);

    if (secondsSinceChange * 1000 > abandonThresholdMs) continue;

    const rosterStatus = daemonStateToAgentStatus(entry.state);
    const isAwaiting = awaitingSlugSet.has(slug) || !!entry.awaitingInput;
    const status: AgentSessionStatus = isAwaiting ? "waiting" : rosterStatus;

    // Find a matching JSONL session for richer info (tool name, activity line)
    const jsonlMatch = jsonlSessions.find((s) => s.sessionId === sessionId || s.projectSlug === slug);

    const session: LiveAgentSession = {
      sessionId,
      projectSlug: slug,
      projectName: entry.projectSlug
        ? entry.projectSlug.replace(/-/g, " ")
        : (jsonlMatch?.projectName ?? slug),
      worktreeLabel: jsonlMatch?.worktreeLabel,
      status,
      lastChangedAt,
      secondsSinceChange,
      currentToolName: entry.activity
        ? undefined
        : (jsonlMatch?.lastToolName ?? undefined),
      currentActivityLine: truncate(entry.activity ?? jsonlMatch?.lastToolName),
      awaitingInputSince: isAwaiting ? lastChangedAt : undefined,
      runningProcess: entry.processRunning !== false,
      livenessSource: "daemon",
      model: entry.model,
    };
    result.set(sessionId, session);
  }

  // Hook-only sessions (live hooks but not in roster — foreground sessions)
  for (const jsonlSession of jsonlSessions) {
    const { sessionId } = jsonlSession;
    if (result.has(sessionId)) continue;
    if (rosterBySessionId.has(sessionId)) continue;

    const hookBuffer = getHookBuffer(jsonlSession.projectSlug);
    const lastHookEvent = [...hookBuffer].at(-1);
    const isLiveFromHook = liveSlugSet.has(jsonlSession.projectSlug);

    if (!isLiveFromHook && !lastHookEvent) continue;

    const lastChangedAt = lastHookEvent
      ? new Date(lastHookEvent.receivedAt).toISOString()
      : jsonlSession.mtime;
    const lastMs = new Date(lastChangedAt).getTime();
    const secondsSinceChange = Math.floor((now - lastMs) / 1000);

    if (secondsSinceChange * 1000 > abandonThresholdMs) continue;

    const isAwaiting = awaitingSlugSet.has(jsonlSession.projectSlug);
    const isStoppedByHook = lastHookEvent && STOP_EVENTS.has(lastHookEvent.hookEventName);
    let status: AgentSessionStatus;
    if (isStoppedByHook) {
      status = "completed";
    } else if (isAwaiting) {
      status = "waiting";
    } else {
      status = liveStatusToAgentStatus(jsonlSession.status);
    }

    result.set(sessionId, {
      sessionId,
      projectSlug: jsonlSession.projectSlug,
      projectName: jsonlSession.projectName,
      worktreeLabel: jsonlSession.worktreeLabel,
      status,
      lastChangedAt,
      secondsSinceChange,
      currentToolName: lastHookEvent?.toolName ?? jsonlSession.lastToolName,
      currentActivityLine: truncate(lastHookEvent?.toolName ?? jsonlSession.lastToolName),
      awaitingInputSince: isAwaiting ? lastChangedAt : undefined,
      runningProcess: false,
      livenessSource: "hook",
    });
  }

  // Pure-JSONL fallback: sessions that appeared in JSONL status but weren't
  // captured by daemon or hooks.
  for (const jsonlSession of jsonlSessions) {
    const { sessionId } = jsonlSession;
    if (result.has(sessionId)) continue;

    const mtimeMs = new Date(jsonlSession.mtime).getTime();
    const secondsSinceChange = Math.floor((now - mtimeMs) / 1000);
    if (secondsSinceChange * 1000 > abandonThresholdMs) continue;

    const jsonlStatus = liveStatusToAgentStatus(jsonlSession.status);
    if (jsonlStatus === "idle" && secondsSinceChange > 300) continue; // skip old idle sessions

    result.set(sessionId, {
      sessionId,
      projectSlug: jsonlSession.projectSlug,
      projectName: jsonlSession.projectName,
      worktreeLabel: jsonlSession.worktreeLabel,
      status: jsonlStatus,
      lastChangedAt: jsonlSession.mtime,
      secondsSinceChange,
      currentToolName: jsonlSession.lastToolName,
      currentActivityLine: truncate(jsonlSession.lastToolName),
      runningProcess: false,
      livenessSource: "jsonl",
    });
  }

  const sessions = [...result.values()];

  sessions.sort((a, b) => {
    const diff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (diff !== 0) return diff;
    return a.secondsSinceChange - b.secondsSinceChange;
  });

  return sessions;
}
