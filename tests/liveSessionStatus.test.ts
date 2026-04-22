import { describe, it, expect } from "vitest";
import { inferLiveSessionStatus } from "@/lib/scanner/liveSessionStatus";
import type { ConversationEntry } from "@/lib/scanner/claudeConversations";

function makeMtime(ageMs: number): Date {
  return new Date(Date.now() - ageMs);
}

function assistantEntry(opts: {
  stopReason?: string;
  tools?: { id: string; name: string }[];
  sidechain?: boolean;
}): ConversationEntry {
  const content: any[] = [];
  for (const t of opts.tools ?? []) {
    content.push({ type: "tool_use", id: t.id, name: t.name });
  }
  if (!opts.tools?.length) {
    content.push({ type: "text", text: "Done." });
  }
  return {
    type: "assistant",
    isSidechain: opts.sidechain ?? false,
    message: {
      role: "assistant",
      stop_reason: opts.stopReason ?? "end_turn",
      content,
    },
  };
}

function userToolResult(toolUseId: string): ConversationEntry {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    },
  };
}

describe("inferLiveSessionStatus", () => {
  it("returns other when no assistant entries", () => {
    expect(inferLiveSessionStatus([], makeMtime(0), undefined).status).toBe("other");
  });

  it("returns waiting when last assistant turn is end_turn with no tools", () => {
    const entries = [assistantEntry({ stopReason: "end_turn" })];
    expect(inferLiveSessionStatus(entries, makeMtime(60_000), undefined).status).toBe("waiting");
  });

  it("returns waiting when all tools resolved and stop_reason is end_turn", () => {
    const entries: ConversationEntry[] = [
      assistantEntry({ stopReason: "tool_use", tools: [{ id: "id-1", name: "Bash" }] }),
      userToolResult("id-1"),
      assistantEntry({ stopReason: "end_turn" }),
    ];
    expect(inferLiveSessionStatus(entries, makeMtime(60_000), undefined).status).toBe("waiting");
  });

  it("returns working when Bash tool is pending and mtime is fresh", () => {
    const entries = [
      assistantEntry({ stopReason: "tool_use", tools: [{ id: "id-2", name: "Bash" }] }),
    ];
    expect(inferLiveSessionStatus(entries, makeMtime(10_000), undefined).status).toBe("working");
  });

  it("returns working when Edit tool is pending but mtime is still fresh (not yet stalled)", () => {
    const entries = [
      assistantEntry({ stopReason: "tool_use", tools: [{ id: "id-3", name: "Edit" }] }),
    ];
    // Not stalled — previous mtime is undefined (first poll)
    expect(inferLiveSessionStatus(entries, makeMtime(10_000), undefined).status).toBe("working");
  });

  it("returns approval when Edit tool is pending and mtime is stalled across polls", () => {
    const mtime = makeMtime(30_000); // 30s old, within active window
    const entries = [
      assistantEntry({ stopReason: "tool_use", tools: [{ id: "id-4", name: "Edit" }] }),
    ];
    // previousMtimeMs matches current mtime → stalled
    expect(
      inferLiveSessionStatus(entries, mtime, mtime.getTime()).status
    ).toBe("approval");
  });

  it("returns approval for Write tool when stalled", () => {
    const mtime = makeMtime(20_000);
    const entries = [
      assistantEntry({ stopReason: "tool_use", tools: [{ id: "id-5", name: "Write" }] }),
    ];
    expect(inferLiveSessionStatus(entries, mtime, mtime.getTime()).status).toBe("approval");
  });

  it("returns approval for NotebookEdit when stalled", () => {
    const mtime = makeMtime(25_000);
    const entries = [
      assistantEntry({ stopReason: "tool_use", tools: [{ id: "id-6", name: "NotebookEdit" }] }),
    ];
    expect(inferLiveSessionStatus(entries, mtime, mtime.getTime()).status).toBe("approval");
  });

  it("does NOT return approval for Bash even when stalled", () => {
    const mtime = makeMtime(40_000);
    const entries = [
      assistantEntry({ stopReason: "tool_use", tools: [{ id: "id-7", name: "Bash" }] }),
    ];
    // Stalled mtime but Bash — should stay working (or other if really stale)
    expect(
      inferLiveSessionStatus(entries, mtime, mtime.getTime()).status
    ).toBe("working");
  });

  it("returns other when mtime is stale (> 10min)", () => {
    const entries = [
      assistantEntry({ stopReason: "tool_use", tools: [{ id: "id-8", name: "Edit" }] }),
    ];
    expect(
      inferLiveSessionStatus(entries, makeMtime(12 * 60_000), undefined).status
    ).toBe("other");
  });

  it("exposes lastToolName for the unresolved tool", () => {
    const entries = [
      assistantEntry({ stopReason: "tool_use", tools: [{ id: "id-9", name: "WebFetch" }] }),
    ];
    const result = inferLiveSessionStatus(entries, makeMtime(5_000), undefined);
    expect(result.lastToolName).toBe("WebFetch");
  });

  it("returns working for all-resolved tool_use with fresh mtime (tool_use stop_reason, intermediate state)", () => {
    const entries = [
      assistantEntry({ stopReason: "tool_use", tools: [{ id: "id-10", name: "Bash" }] }),
      userToolResult("id-10"),
      // no further assistant entry yet — Claude is computing
    ];
    expect(
      inferLiveSessionStatus(entries, makeMtime(5_000), undefined).status
    ).toBe("working");
  });

  it("ignores sidechain entries when finding last assistant turn", () => {
    const entries: ConversationEntry[] = [
      assistantEntry({ stopReason: "end_turn" }),
      assistantEntry({ stopReason: "tool_use", tools: [{ id: "sc-1", name: "Edit" }], sidechain: true }),
    ];
    expect(inferLiveSessionStatus(entries, makeMtime(10_000), undefined).status).toBe("waiting");
  });
});
