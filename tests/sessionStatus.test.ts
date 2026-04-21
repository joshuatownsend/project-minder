import { describe, it, expect } from "vitest";
import { inferSessionStatus } from "@/lib/scanner/sessionStatus";
import type { ConversationEntry } from "@/lib/scanner/claudeConversations";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeMtime(ageMs: number): Date {
  return new Date(Date.now() - ageMs);
}

function assistantEntry(opts: {
  stopReason?: string;
  toolUseIds?: string[];
  sidechain?: boolean;
}): ConversationEntry {
  const content: any[] = [];
  for (const id of opts.toolUseIds ?? []) {
    content.push({ type: "tool_use", id, name: "Bash" });
  }
  if (!opts.toolUseIds?.length) {
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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("inferSessionStatus", () => {
  it("returns idle when no assistant entries", () => {
    const entries: ConversationEntry[] = [
      { type: "attachment" },
      { type: "system" },
    ];
    expect(inferSessionStatus(entries, makeMtime(0))).toBe("idle");
  });

  it("returns idle when last assistant turn is end_turn with no tool_use", () => {
    const entries: ConversationEntry[] = [
      assistantEntry({ stopReason: "end_turn" }),
    ];
    expect(inferSessionStatus(entries, makeMtime(5 * 60_000))).toBe("idle");
  });

  it("returns idle when all tool_use are paired with tool_result", () => {
    const entries: ConversationEntry[] = [
      assistantEntry({ stopReason: "tool_use", toolUseIds: ["id-1"] }),
      userToolResult("id-1"),
    ];
    expect(inferSessionStatus(entries, makeMtime(5 * 60_000))).toBe("idle");
  });

  it("returns working when unpaired tool_use is fresh (< 90s)", () => {
    const entries: ConversationEntry[] = [
      assistantEntry({ stopReason: "tool_use", toolUseIds: ["id-2"] }),
      // No tool_result follows
    ];
    expect(inferSessionStatus(entries, makeMtime(30_000))).toBe("working");
  });

  it("returns needs_attention when unpaired tool_use is 90s–10min old", () => {
    const entries: ConversationEntry[] = [
      assistantEntry({ stopReason: "tool_use", toolUseIds: ["id-3"] }),
    ];
    expect(inferSessionStatus(entries, makeMtime(3 * 60_000))).toBe("needs_attention");
  });

  it("returns idle (stale) when unpaired tool_use is > 10min old", () => {
    const entries: ConversationEntry[] = [
      assistantEntry({ stopReason: "tool_use", toolUseIds: ["id-4"] }),
    ];
    expect(inferSessionStatus(entries, makeMtime(15 * 60_000))).toBe("idle");
  });

  it("ignores sidechain entries when finding last assistant turn", () => {
    // Last entry is a sidechain assistant — should be ignored.
    // The meaningful last turn is end_turn → idle.
    const entries: ConversationEntry[] = [
      assistantEntry({ stopReason: "end_turn" }),
      assistantEntry({ stopReason: "tool_use", toolUseIds: ["sc-1"], sidechain: true }),
    ];
    expect(inferSessionStatus(entries, makeMtime(30_000))).toBe("idle");
  });

  it("correctly identifies the last of multiple assistant turns", () => {
    // First turn has pending tool, last turn is clean end_turn → idle.
    const entries: ConversationEntry[] = [
      assistantEntry({ stopReason: "tool_use", toolUseIds: ["old-id"] }),
      userToolResult("old-id"),
      assistantEntry({ stopReason: "tool_use", toolUseIds: ["new-id"] }),
      userToolResult("new-id"),
      assistantEntry({ stopReason: "end_turn" }),
    ];
    expect(inferSessionStatus(entries, makeMtime(5 * 60_000))).toBe("idle");
  });
});
