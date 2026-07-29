// Pending tool-approval registry.
//
// Claude Code's `PreToolUse` hook is synchronous: it blocks the tool call
// until the hook process exits, and reads its stdout for a decision. That
// makes a remote-approval loop possible — the hook POSTs here, this module
// holds the request open until someone decides (dashboard, phone on the
// LAN), and the decision is written back as the hook's output.
//
// Minder's existing `/api/hooks` receiver is fire-and-forget: it records
// activity and returns immediately. This is the opposite shape, so it
// lives in its own module rather than complicating that route.
//
// ── Three properties, each of which is a deliberate design decision ────
//
// 1. **FAIL OPEN, ALWAYS.** Every failure path — timeout, server not
//    running, malformed payload, internal throw — must end with Claude
//    falling back to its normal terminal prompt. A monitoring tool that
//    can wedge the thing it monitors is worse than no monitoring tool.
//    Concretely: this module never returns "deny" on its own, only on an
//    explicit human decision. The absence of an answer is not a no.
//
// 2. **REPLAY-SAFE.** A decision is honoured only while that exact request
//    is still pending. Deciding twice, deciding after a timeout, or
//    replaying a captured decision id all no-op. Without this, a stale
//    notification tapped ten minutes later could approve a *different*
//    tool call that happened to be waiting.
//
// 3. **BOUNDED.** Entries expire on a deadline and are swept, so a hook
//    that dies mid-request (terminal closed, machine slept) cannot leak an
//    entry forever. The registry is memory-only by design: a pending
//    approval is meaningless once the process holding the hook is gone, so
//    persisting it across restarts would only ever resurrect dead prompts.

import { isReadOnlyTool } from "./readOnlyTools";

/** What a human can answer. */
export type ApprovalDecision = "allow" | "allow_all" | "deny";

/** How a request was resolved. `timeout` and `bypassed` both fail open. */
export type ApprovalOutcome = ApprovalDecision | "timeout" | "bypassed" | "auto_allow";

export interface ApprovalRequestInput {
  sessionId: string | null;
  toolName: string;
  /** Short human-readable summary — a command line, a file path, a diff. */
  summary: string;
  projectSlug?: string | null;
  cwd?: string | null;
}

export interface PendingApproval extends ApprovalRequestInput {
  id: string;
  createdAtMs: number;
  expiresAtMs: number;
}

/** Default wait before failing open. Matches claude-pulse's 60s. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

interface Waiter {
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface StoreState {
  pending: Map<string, PendingApproval>;
  waiters: Map<string, Waiter>;
  /**
   * Sessions that answered "allow all". Session-scoped rather than global
   * so one unattended run cannot silently disarm the gate for every other
   * session on the machine.
   */
  allowAll: Set<string>;
  seq: number;
}

// `globalThis` singleton, matching `gitStatusCache` / `githubActivityCache`:
// Next dev-mode HMR re-evaluates modules, and a module-local Map would
// orphan every in-flight waiter on every edit.
const KEY = "__minderApprovals";
function state(): StoreState {
  const g = globalThis as unknown as Record<string, StoreState | undefined>;
  if (!g[KEY]) {
    g[KEY] = { pending: new Map(), waiters: new Map(), allowAll: new Set(), seq: 0 };
  }
  return g[KEY]!;
}

/**
 * Monotonic, unguessable-enough request id. Not a security boundary — the
 * endpoint binds to localhost and the id is only a correlation handle —
 * but a counter alone would make ids trivially predictable across
 * restarts, which matters once a decision URL can be tapped from a phone.
 */
function newId(seq: number): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `apr_${seq.toString(36)}_${rand}`;
}

/** Drop entries past their deadline. Called on every public entry point. */
function sweep(nowMs: number): void {
  const s = state();
  for (const [id, entry] of s.pending) {
    if (entry.expiresAtMs <= nowMs) {
      s.pending.delete(id);
      const w = s.waiters.get(id);
      if (w) {
        clearTimeout(w.timer);
        s.waiters.delete(id);
        w.resolve("timeout");
      }
    }
  }
}

/**
 * Register a request and wait for a decision.
 *
 * Resolves with:
 * - `"bypassed"` immediately for read-only tools (no entry created)
 * - `"auto_allow"` immediately when the session answered "allow all"
 * - the human decision, when one arrives in time
 * - `"timeout"` when the deadline passes
 *
 * Never rejects and never blocks past `timeoutMs`.
 */
export function requestApproval(
  input: ApprovalRequestInput,
  timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
  nowMs: number = Date.now()
): { id: string | null; outcome: Promise<ApprovalOutcome> } {
  sweep(nowMs);
  const s = state();

  // Read-only tools never reach a human — see readOnlyTools.ts.
  if (isReadOnlyTool(input.toolName)) {
    return { id: null, outcome: Promise.resolve("bypassed") };
  }
  if (input.sessionId && s.allowAll.has(input.sessionId)) {
    return { id: null, outcome: Promise.resolve("auto_allow") };
  }

  const id = newId(s.seq++);
  const entry: PendingApproval = {
    ...input,
    id,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + timeoutMs,
  };
  s.pending.set(id, entry);

  const outcome = new Promise<ApprovalOutcome>((resolve) => {
    const timer = setTimeout(() => {
      // Deadline reached with no answer → fail open. Clean up first so a
      // decision arriving microseconds later can't resolve a dead waiter.
      const cur = state();
      cur.pending.delete(id);
      cur.waiters.delete(id);
      resolve("timeout");
    }, timeoutMs);
    // Don't hold the process open for a pending approval — the server
    // should be able to shut down cleanly mid-request.
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    s.waiters.set(id, { resolve, timer });
  });

  return { id, outcome };
}

/**
 * Record a human decision.
 *
 * Returns `false` when `id` is not currently pending — already decided,
 * already timed out, or never existed. That return value IS the
 * replay-safety property: callers surface it as "this request is no longer
 * waiting" rather than silently appearing to succeed.
 */
export function decideApproval(
  id: string,
  decision: ApprovalDecision,
  nowMs: number = Date.now()
): boolean {
  sweep(nowMs);
  const s = state();
  const entry = s.pending.get(id);
  if (!entry) return false;

  s.pending.delete(id);
  const w = s.waiters.get(id);
  if (w) {
    clearTimeout(w.timer);
    s.waiters.delete(id);
  }

  if (decision === "allow_all" && entry.sessionId) {
    s.allowAll.add(entry.sessionId);
  }
  // Resolve after mutating `allowAll`, so a hook racing on the same
  // session sees the flag already set.
  w?.resolve(decision);
  return true;
}

/** Currently-waiting requests, oldest first. */
export function listPendingApprovals(nowMs: number = Date.now()): PendingApproval[] {
  sweep(nowMs);
  return [...state().pending.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
}

/** True when this session previously answered "allow all". */
export function isSessionAutoAllowed(sessionId: string): boolean {
  return state().allowAll.has(sessionId);
}

/** Re-arm the gate for a session that had answered "allow all". */
export function clearSessionAutoAllow(sessionId: string): boolean {
  return state().allowAll.delete(sessionId);
}

/** Test seam: drop all state, including timers. */
export function _resetApprovalsForTesting(): void {
  const s = state();
  for (const w of s.waiters.values()) clearTimeout(w.timer);
  s.pending.clear();
  s.waiters.clear();
  s.allowAll.clear();
  s.seq = 0;
}
