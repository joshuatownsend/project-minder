import { describe, it, expect } from "vitest";
import { buildFileCoupling } from "@/lib/usage/fileCoupling";
import type { UsageTurn } from "@/lib/usage/types";

function makeTurn(
  sessionId: string,
  files: string[],
  tool = "Edit"
): UsageTurn {
  return {
    timestamp: "2024-01-01T00:00:00.000Z",
    sessionId,
    projectSlug: "proj",
    projectDirName: "C--dev-proj",
    model: "claude-opus-4-5",
    role: "assistant",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: files.map((f) => ({ name: tool, arguments: { file_path: f } })),
  };
}

describe("buildFileCoupling", () => {
  it("detects co-edited pairs across sessions", () => {
    const turns = [
      makeTurn("s1", ["a.ts", "b.ts"]),
      makeTurn("s2", ["a.ts", "b.ts"]),
    ];
    const { pairs } = buildFileCoupling(turns, 2);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].fileA).toBe("a.ts");
    expect(pairs[0].fileB).toBe("b.ts");
    expect(pairs[0].coOccurrences).toBe(2);
  });

  it("respects minCoOccurrences threshold", () => {
    const turns = [
      makeTurn("s1", ["a.ts", "b.ts"]),
    ];
    const { pairs } = buildFileCoupling(turns, 2);
    expect(pairs).toHaveLength(0);
  });

  it("computes Jaccard-like strength correctly", () => {
    // a.ts appears in 4 sessions, b.ts in 2, co-occur in 2
    // strength = 2 / max(4, 2) = 0.5
    const turns = [
      makeTurn("s1", ["a.ts", "b.ts"]),
      makeTurn("s2", ["a.ts", "b.ts"]),
      makeTurn("s3", ["a.ts"]),
      makeTurn("s4", ["a.ts"]),
    ];
    const { pairs } = buildFileCoupling(turns, 2);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].strength).toBeCloseTo(0.5);
  });

  it("uses canonical (sorted) pair ordering so a+b === b+a", () => {
    const turns = [
      makeTurn("s1", ["b.ts", "a.ts"]),
      makeTurn("s2", ["a.ts", "b.ts"]),
    ];
    const { pairs } = buildFileCoupling(turns, 2);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].fileA).toBe("a.ts");
    expect(pairs[0].fileB).toBe("b.ts");
  });

  it("counts each file only once per session even if edited multiple times", () => {
    const turns = [
      makeTurn("s1", ["a.ts", "a.ts", "b.ts"]), // a.ts twice in same session
      makeTurn("s2", ["a.ts", "b.ts"]),
    ];
    const { pairs } = buildFileCoupling(turns, 2);
    expect(pairs[0].coOccurrences).toBe(2);
  });

  it("excludes Read ops from coupling analysis", () => {
    const turns = [
      makeTurn("s1", ["a.ts"], "Read"), // only reads — no write-class ops
      makeTurn("s2", ["a.ts"], "Read"),
    ];
    const { pairs, totalSessions } = buildFileCoupling(turns, 1);
    expect(pairs).toHaveLength(0);
    expect(totalSessions).toBe(0);
  });

  it("respects the limit parameter", () => {
    // 5 files → 10 pairs; limit to 3
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const turns = [
      makeTurn("s1", files),
      makeTurn("s2", files),
    ];
    const { pairs } = buildFileCoupling(turns, 2, 3);
    expect(pairs).toHaveLength(3);
  });

  it("returns zero totals for empty turns", () => {
    const { pairs, totalSessions } = buildFileCoupling([]);
    expect(pairs).toHaveLength(0);
    expect(totalSessions).toBe(0);
  });
});
