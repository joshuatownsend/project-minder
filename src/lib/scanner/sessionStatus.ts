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
 */
export function inferSessionStatus(
  entries: ConversationEntry[],
  mtime: Date,
): SessionStatus {
  let lastAssistantIdx = -1;

  // Walk backward to the last meaningful assistant turn (exclude sidechains).
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "assistant" && !e.isSidechain && Array.isArray(e.message?.content)) {
      lastAssistantIdx = i;
      break;
    }
  }

  if (lastAssistantIdx === -1) return "idle";

  const entry = entries[lastAssistantIdx];
  const content = entry.message!.content as any[];
  const stopReason = (entry.message as any)?.stop_reason as string | undefined;

  // Collect tool_use IDs from the last assistant turn.
  const pendingIds = new Set<string>();
  for (const block of content) {
    if (block?.type === "tool_use" && block.id) {
      pendingIds.add(block.id);
    }
  }

  // Naturally completed turn with no pending tools → idle.
  if (stopReason === "end_turn" && pendingIds.size === 0) return "idle";

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

  if (pendingIds.size === 0) return "idle";

  // Unresolved tool_use — classify by mtime age.
  const ageMs = Date.now() - mtime.getTime();
  if (ageMs < WORKING_MS) return "working";
  if (ageMs > STALE_MS) return "idle"; // abandoned
  return "needs_attention";
}
