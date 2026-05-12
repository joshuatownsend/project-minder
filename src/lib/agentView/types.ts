import type { HookEventName } from "@/lib/types";

/**
 * Operational status for the Kanban board — superset of LiveSessionStatus.
 * Maps to board columns in this order: waiting → working → idle → completed → failed → stopped.
 *
 * LiveSessionStatus "approval" → "waiting" (same concept: held for user input)
 * LiveSessionStatus "other"    → "idle"    (inactive but not definitively done)
 */
export type AgentSessionStatus =
  | "waiting"
  | "working"
  | "idle"
  | "completed"
  | "failed"
  | "stopped";

/** Source that last determined liveness — used to show the "running process" indicator. */
export type LivenessSource = "daemon" | "hook" | "jsonl";

/** One live session as shown on the Kanban board. */
export interface LiveAgentSession {
  sessionId: string;
  projectSlug: string;
  projectName: string;
  worktreeLabel?: string;
  status: AgentSessionStatus;
  /** ISO8601 of last observed change (JSONL mtime, hook event, or job state mtime). */
  lastChangedAt: string;
  /** Seconds since lastChangedAt, computed at aggregate time. */
  secondsSinceChange: number;
  /** Most recent tool_use name or the tool implied by last hook event. */
  currentToolName?: string;
  /** Short activity line: last tool input excerpt OR last assistant text excerpt (max 80 chars). */
  currentActivityLine?: string;
  /** ISO8601 when this session started awaiting user input; undefined if not waiting. */
  awaitingInputSince?: string;
  /**
   * True when the underlying Claude process appears to be running.
   * Solid dot (daemon) vs hollow dot (jsonl-inferred).
   */
  runningProcess: boolean;
  livenessSource: LivenessSource;
  /** Model identifier from the session. */
  model?: string;
  /** Estimated USD cost so far (from session row in DB if available). */
  costEstimate?: number;
  /**
   * Context fill ratio [0,1]. For live (non-terminal) sessions this reflects
   * the most recent assistant turn (post-compact accuracy). For historical
   * sessions loaded from the DB this is the session's peak fill.
   */
  maxContextFill?: number;
  /** Number of sub-agents currently spawned but not yet stopped (from hook buffer). */
  subagentsInFlight?: number;
}

/** A single entry from `~/.claude/daemon/roster.json`. All fields optional — schema is undocumented. */
export interface JobRosterEntry {
  id: string;
  /** Human-readable session label (e.g. "quirky-scribbling-plum"). */
  slug?: string;
  sessionId?: string;
  projectPath?: string;
  projectSlug?: string;
  /** One of: working | waiting | completed | failed | stopped; may have other values. */
  state?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Daemon-provided activity description. */
  activity?: string;
  /** True when the subprocess is still alive per the daemon. */
  processRunning?: boolean;
  /** Propagated from state.json when the session is awaiting user input. */
  awaitingInput?: boolean;
  /** Model identifier propagated from state.json. */
  model?: string;
  /** Arbitrary extra fields — kept for forward-compat. */
  [key: string]: unknown;
}

/** A single entry from `~/.claude/jobs/<id>/state.json`. All fields optional. */
export interface JobStateEntry {
  id?: string;
  sessionId?: string;
  state?: string;
  activity?: string;
  processRunning?: boolean;
  awaitingInput?: boolean;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** Narrow event emitted onto the globalThis EventEmitter. */
export interface LiveAgentEvent {
  kind: "hook" | "jsonl-tail" | "daemon-change";
  sessionId: string;
  slug: string;
  hookEventName?: HookEventName;
  toolName?: string;
  /** Only set when kind === "hook" and the message is present. */
  message?: string;
}

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "fallback";

/** Canonical list of all statuses — single source of truth for filter chips and column order. */
export const ALL_STATUSES: AgentSessionStatus[] = ["waiting", "working", "idle", "completed", "failed", "stopped"];

/** Sort order for Kanban columns — lower number appears first. */
export const STATUS_ORDER: Record<AgentSessionStatus, number> = {
  waiting: 0, working: 1, idle: 2, completed: 3, failed: 4, stopped: 5,
};
