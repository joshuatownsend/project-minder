import type { ConversationEntry } from "./claudeConversations";
import type { LiveSessionStatus } from "../types";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const WORKING_MS = 90_000;
const STALE_MS = 10 * 60_000;

export function inferLiveSessionStatus(
  entries: ConversationEntry[],
  mtime: Date,
  previousMtimeMs: number | undefined,
): { status: LiveSessionStatus; lastToolName?: string } {
  let lastAssistantIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "assistant" && !e.isSidechain && Array.isArray(e.message?.content)) {
      lastAssistantIdx = i;
      break;
    }
  }

  if (lastAssistantIdx === -1) return { status: "other" };

  const entry = entries[lastAssistantIdx];
  const msg = entry.message!;
  const content = msg.content as any[];
  const stopReason = msg.stop_reason;

  const pendingIds = new Set<string>();
  const pendingWriteIds = new Set<string>();
  let lastToolName: string | undefined;

  for (const block of content) {
    if (block?.type === "tool_use" && block.id) {
      pendingIds.add(block.id);
      if (WRITE_TOOLS.has(block.name)) pendingWriteIds.add(block.id);
      lastToolName = block.name;
    }
  }

  for (let i = lastAssistantIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.isSidechain) continue;
    const userContent = e.message?.content ?? (e as any).content;
    if (!Array.isArray(userContent)) continue;
    for (const block of userContent) {
      if (block?.type === "tool_result" && block.tool_use_id) {
        pendingIds.delete(block.tool_use_id);
        pendingWriteIds.delete(block.tool_use_id);
      }
    }
  }

  const ageMs = Date.now() - mtime.getTime();

  if (pendingIds.size === 0) {
    if (stopReason === "end_turn") return { status: "waiting", lastToolName };
    // stop_reason was tool_use but results all returned — Claude is computing next response
    if (ageMs < WORKING_MS) return { status: "working", lastToolName };
    return { status: "other", lastToolName };
  }

  // Unresolved tool_use — classify by mtime
  if (ageMs > STALE_MS) return { status: "other", lastToolName };
  const stalledMtime = previousMtimeMs !== undefined && mtime.getTime() === previousMtimeMs;
  if (stalledMtime && pendingWriteIds.size > 0) return { status: "approval", lastToolName };
  return { status: "working", lastToolName };
}
