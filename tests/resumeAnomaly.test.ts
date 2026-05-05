import { describe, it, expect } from "vitest";
import { detectResumeAnomaly, RESUME_OUTPUT_SPIKE_RATIO } from "@/lib/usage/resumeAnomaly";
import type { UsageTurn } from "@/lib/usage/types";

function makeTurn(
  timestamp: string,
  outputTokens: number,
  cacheCreateTokens = 0,
  cacheReadTokens = 0
): UsageTurn {
  return {
    timestamp,
    sessionId: "test",
    projectSlug: "test",
    projectDirName: "test",
    model: "claude-sonnet-4-5",
    role: "assistant",
    inputTokens: 1000,
    outputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    toolCalls: [],
  };
}

describe("detectResumeAnomaly", () => {
  it("returns no anomaly when no compact boundaries and no buggy version", () => {
    const turns = [
      makeTurn("2026-05-01T10:00:00Z", 100),
      makeTurn("2026-05-01T10:01:00Z", 120),
    ];
    const result = detectResumeAnomaly(turns, { compactBoundaries: [] });
    expect(result.hasAnomaly).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  it(`flags post-boundary spike at ${RESUME_OUTPUT_SPIKE_RATIO}× pre-boundary median`, () => {
    const boundary = "2026-05-01T10:05:00Z";
    const pre = Array.from({ length: 5 }, (_, i) =>
      makeTurn(`2026-05-01T10:0${i}:00Z`, 100)
    );
    const spikedTurn = makeTurn("2026-05-01T10:06:00Z", 100 * RESUME_OUTPUT_SPIKE_RATIO + 1);
    const result = detectResumeAnomaly([...pre, spikedTurn], {
      compactBoundaries: [boundary],
    });
    expect(result.hasAnomaly).toBe(true);
    expect(result.reasons.some((r) => r.kind === "output-spike")).toBe(true);
  });

  it("does NOT flag a post-boundary turn at 5× pre-boundary median (below threshold)", () => {
    const boundary = "2026-05-01T10:05:00Z";
    const pre = Array.from({ length: 5 }, (_, i) =>
      makeTurn(`2026-05-01T10:0${i}:00Z`, 100)
    );
    // 5× is well below RESUME_OUTPUT_SPIKE_RATIO = 10
    const normalTurn = makeTurn("2026-05-01T10:06:00Z", 500);
    const result = detectResumeAnomaly([...pre, normalTurn], {
      compactBoundaries: [boundary],
    });
    expect(result.hasAnomaly).toBe(false);
  });

  it("flags buggy CLI version 2.1.75 as a reason", () => {
    const result = detectResumeAnomaly([], {
      compactBoundaries: [],
      cliVersion: "2.1.75",
    });
    expect(result.hasAnomaly).toBe(true);
    expect(result.reasons.some((r) => r.kind === "buggy-version")).toBe(true);
  });

  it("does not flag buggy version for 2.1.90", () => {
    const result = detectResumeAnomaly([], {
      compactBoundaries: [],
      cliVersion: "2.1.90",
    });
    expect(result.hasAnomaly).toBe(false);
  });

  it("flags cache rebuild spike (high cacheCreate + near-zero cacheRead)", () => {
    const boundary = "2026-05-01T10:05:00Z";
    const pre = Array.from({ length: 3 }, (_, i) =>
      makeTurn(`2026-05-01T10:0${i}:00Z`, 100)
    );
    const cacheSpike = makeTurn("2026-05-01T10:06:00Z", 100, 6000, 0);
    const result = detectResumeAnomaly([...pre, cacheSpike], {
      compactBoundaries: [boundary],
    });
    expect(result.hasAnomaly).toBe(true);
    expect(result.reasons.some((r) => r.kind === "cache-spike")).toBe(true);
  });

  it("ignores user turns when computing spike ratio", () => {
    const boundary = "2026-05-01T10:05:00Z";
    const userTurn: UsageTurn = {
      timestamp: "2026-05-01T10:06:00Z",
      sessionId: "test",
      projectSlug: "test",
      projectDirName: "test",
      model: "",
      role: "user",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      toolCalls: [],
    };
    const pre = Array.from({ length: 3 }, (_, i) =>
      makeTurn(`2026-05-01T10:0${i}:00Z`, 100)
    );
    const result = detectResumeAnomaly([...pre, userTurn], {
      compactBoundaries: [boundary],
    });
    // User turns are filtered out — no post-boundary assistant turns → no spike
    expect(result.hasAnomaly).toBe(false);
  });
});
