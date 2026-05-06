import { describe, it, expect } from "vitest";
import { computeToolTransitions } from "@/lib/usage/toolTransitions";
import type { UsageTurn } from "@/lib/usage/types";

function makeTurn(sessionId: string, timestamp: string, tools: string[]): UsageTurn {
  return {
    sessionId,
    projectSlug: "test",
    projectDirName: "test",
    timestamp,
    role: "assistant",
    model: "claude-sonnet-4-5",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    toolCalls: tools.map((name) => ({ name, id: name })),
    isSidechain: false,
  } as UsageTurn;
}

describe("computeToolTransitions", () => {
  it("returns empty arrays for no turns", () => {
    const { transitions, selfLoops } = computeToolTransitions([]);
    expect(transitions).toHaveLength(0);
    expect(selfLoops).toHaveLength(0);
  });

  it("returns empty arrays for turns with no tool calls", () => {
    const { transitions, selfLoops } = computeToolTransitions([
      makeTurn("s1", "2026-01-01T00:00:00Z", []),
    ]);
    expect(transitions).toHaveLength(0);
    expect(selfLoops).toHaveLength(0);
  });

  it("records intra-turn consecutive pairs", () => {
    const { transitions, selfLoops } = computeToolTransitions([
      makeTurn("s1", "2026-01-01T00:00:00Z", ["Read", "Edit", "Bash"]),
    ]);
    expect(transitions).toEqual(expect.arrayContaining([
      { from: "Read", to: "Edit", count: 1 },
      { from: "Edit", to: "Bash", count: 1 },
    ]));
    expect(selfLoops).toHaveLength(0);
  });

  it("folds same-tool consecutive intra-turn calls into selfLoops", () => {
    const { transitions, selfLoops } = computeToolTransitions([
      makeTurn("s1", "2026-01-01T00:00:00Z", ["Read", "Read", "Read"]),
    ]);
    expect(transitions).toHaveLength(0);
    expect(selfLoops).toEqual([{ tool: "Read", count: 2 }]);
  });

  it("records inter-turn transitions within same session", () => {
    const { transitions } = computeToolTransitions([
      makeTurn("s1", "2026-01-01T00:00:00Z", ["Read"]),
      makeTurn("s1", "2026-01-01T00:01:00Z", ["Edit"]),
    ]);
    expect(transitions).toEqual(expect.arrayContaining([
      { from: "Read", to: "Edit", count: 1 },
    ]));
  });

  it("resets prev at session boundary (no cross-session transitions)", () => {
    const { transitions } = computeToolTransitions([
      makeTurn("s1", "2026-01-01T00:00:00Z", ["Bash"]),
      makeTurn("s2", "2026-01-01T00:01:00Z", ["Read"]),
    ]);
    // s1's last tool "Bash" must not pair with s2's first tool "Read"
    const crossSession = transitions.find((t) => t.from === "Bash" && t.to === "Read");
    expect(crossSession).toBeUndefined();
  });

  it("folds inter-turn same-tool repetition into selfLoops", () => {
    const { transitions, selfLoops } = computeToolTransitions([
      makeTurn("s1", "2026-01-01T00:00:00Z", ["Bash"]),
      makeTurn("s1", "2026-01-01T00:01:00Z", ["Bash"]),
    ]);
    expect(transitions).toHaveLength(0);
    expect(selfLoops).toEqual([{ tool: "Bash", count: 1 }]);
  });

  it("accumulates counts across multiple turns", () => {
    const turns = [
      makeTurn("s1", "2026-01-01T00:00:00Z", ["Read", "Edit"]),
      makeTurn("s1", "2026-01-01T00:01:00Z", ["Read", "Edit"]),
    ];
    const { transitions } = computeToolTransitions(turns);
    const readEdit = transitions.find((t) => t.from === "Read" && t.to === "Edit");
    // 2 intra-turn + 1 inter-turn (Edit→Read) + 1 intra-turn on 2nd turn
    expect(readEdit?.count).toBe(2);
  });

  it("truncates to top 200 transitions", () => {
    // Create 201 distinct tool pairs
    const tools: string[] = [];
    for (let i = 0; i < 202; i++) tools.push(`T${i}`);
    const { transitions } = computeToolTransitions([
      makeTurn("s1", "2026-01-01T00:00:00Z", tools),
    ]);
    expect(transitions.length).toBeLessThanOrEqual(200);
  });

  it("sorts transitions by count descending", () => {
    const turns = [
      makeTurn("s1", "2026-01-01T00:00:00Z", ["Read", "Edit"]),
      makeTurn("s1", "2026-01-01T00:01:00Z", ["Read", "Edit"]),
      makeTurn("s1", "2026-01-01T00:02:00Z", ["Bash", "Edit"]),
    ];
    const { transitions } = computeToolTransitions(turns);
    for (let i = 1; i < transitions.length; i++) {
      expect(transitions[i - 1].count).toBeGreaterThanOrEqual(transitions[i].count);
    }
  });
});
