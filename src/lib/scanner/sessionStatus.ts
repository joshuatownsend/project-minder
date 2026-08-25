import type { SessionStatus } from "../types";
import type { ConversationEntry } from "./claudeConversations";

// Thresholds for classifying an unresolved tool_use by age.
const WORKING_MS = 90_000;     // < 90s  → still likely executing
const STALE_MS   = 10 * 60_000; // > 10min → abandoned, treat as idle

/**
 * Infer session status from parsed JSONL entries and file mtime.
 *
 * Algorithm:
 *   1. Walk entries backward to find the last non-sidechain assistant turn.
 *   2. Collect tool_use IDs from that turn.
 *   3. If stop_reason === 'end_turn' and no tool_use blocks → idle.
 *   4. Walk forward from that index looking for matching tool_result IDs.
 *   5. Any unpaired tool_use → working (fresh mtime) or needs_attention (stale mtime).
 *   6. All paired → idle.
 *
 * Split into two halves (#473) because a status is a function of BOTH the file
 * and the clock, and only the first half is cacheable. `hasUnresolvedToolUse`
 * depends solely on the parsed entries, so it survives in a mtime-keyed cache
 * for as long as the file is untouched; `statusFromPending` depends on the
 * current time and must be re-evaluated on every read. Caching the composed
 * answer would freeze a session at `working` forever — the file stops changing
 * precisely when the session is abandoned, which is the case the age
 * thresholds exist to detect.
 */
export function inferSessionStatus(
  entries: ConversationEntry[],
  mtime: Date,
): SessionStatus {
  return statusFromPending(hasUnresolvedToolUse(entries), mtime);
}

/**
 * Steps 1–4 above: does the last meaningful assistant turn have a `tool_use`
 * with no matching `tool_result`? Pure function of the transcript — no clock.
 */
export function hasUnresolvedToolUse(entries: ConversationEntry[]): boolean {
  let lastAssistantIdx = -1;

  // Walk backward to the last meaningful assistant turn (exclude sidechains).
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "assistant" && !e.isSidechain && Array.isArray(e.message?.content)) {
      lastAssistantIdx = i;
      break;
    }
  }

  if (lastAssistantIdx === -1) return false;

  const entry = entries[lastAssistantIdx];
  const msg = entry.message!;
  const content = msg.content as any[];
  const stopReason = msg.stop_reason;

  // Collect tool_use IDs from the last assistant turn.
  const pendingIds = new Set<string>();
  for (const block of content) {
    if (block?.type === "tool_use" && block.id) {
      pendingIds.add(block.id);
    }
  }

  // Naturally completed turn with no pending tools → nothing outstanding.
  if (stopReason === "end_turn" && pendingIds.size === 0) return false;

  // Walk forward to find matching tool_result blocks.
  for (let i = lastAssistantIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.isSidechain) continue;
    const userContent = e.message?.content ?? (e as any).content;
    if (!Array.isArray(userContent)) continue;
    for (const block of userContent) {
      if (block?.type === "tool_result" && block.tool_use_id) {
        pendingIds.delete(block.tool_use_id);
      }
    }
  }

  return pendingIds.size > 0;
}

/**
 * Step 5: age-classify an unresolved tool call. Depends on the wall clock, so
 * callers holding a cached `hasUnresolvedToolUse` must re-run this per read.
 */
export function statusFromPending(
  hasPending: boolean,
  mtime: Date,
  now: number = Date.now(),
): SessionStatus {
  if (!hasPending) return "idle";
  const ageMs = now - mtime.getTime();
  if (ageMs < WORKING_MS) return "working";
  if (ageMs > STALE_MS) return "idle"; // abandoned
  return "needs_attention";
}
