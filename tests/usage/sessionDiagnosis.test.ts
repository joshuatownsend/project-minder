import { describe, it, expect, beforeEach } from "vitest";
import { diagnoseSession } from "@/lib/usage/sessionDiagnosis";
import { _resetWarnedModelsForTesting } from "@/lib/usage/sessionQuality";
import type { UsageTurn } from "@/lib/usage/types";

beforeEach(() => {
  _resetWarnedModelsForTesting();
});

let counter = 0;
function ts(offsetSec: number): string {
  // Anchor sessions to a fixed start so spike windows in cache-thrash tests
  // are deterministic. `offsetSec` is seconds past the anchor.
  const anchor = Date.parse("2026-04-01T12:00:00Z");
  return new Date(anchor + offsetSec * 1000).toISOString();
}

function assistantTurn(args: Partial<UsageTurn> & { offsetSec?: number }): UsageTurn {
  counter++;
  return {
    timestamp: args.timestamp ?? ts(args.offsetSec ?? counter * 60),
    sessionId: "diag-session",
    projectSlug: "p",
    projectDirName: "p",
    model: args.model ?? "claude-sonnet-4-6",
    role: "assistant",
    inputTokens: args.inputTokens ?? 0,
    outputTokens: args.outputTokens ?? 0,
    cacheCreateTokens: args.cacheCreateTokens ?? 0,
    cacheReadTokens: args.cacheReadTokens ?? 0,
    toolCalls: [],
    isError: args.isError,
  };
}

function userTurn(args: Partial<UsageTurn> & { offsetSec?: number }): UsageTurn {
  counter++;
  return {
    timestamp: args.timestamp ?? ts(args.offsetSec ?? counter * 60),
    sessionId: "diag-session",
    projectSlug: "p",
    projectDirName: "p",
    model: "",
    role: "user",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    toolResultText: args.toolResultText,
  };
}

describe("diagnoseSession", () => {
  beforeEach(() => {
    counter = 0;
  });

  it("emits zero findings on a clean session", () => {
    const turns: UsageTurn[] = [];
    for (let i = 0; i < 10; i++) {
      turns.push(assistantTurn({ inputTokens: 20_000, outputTokens: 5_000, offsetSec: i * 60 }));
      turns.push(userTurn({ toolResultText: "ok", offsetSec: i * 60 + 10 }));
    }
    const report = diagnoseSession("s", turns);
    expect(report.findings).toEqual([]);
    expect(report.outcome).toBe("abandoned"); // last turn is user
  });

  it("flags near-compaction when peak fill exceeds 83%", () => {
    const turns = [
      assistantTurn({ inputTokens: 175_000, offsetSec: 0 }),
      userTurn({ toolResultText: "ok", offsetSec: 30 }),
    ];
    const report = diagnoseSession("s", turns);
    expect(report.findings.some((f) => f.category === "near-compaction")).toBe(true);
  });

  it("suppresses context-bloat when near-compaction also fires", () => {
    const turns = [
      assistantTurn({ inputTokens: 175_000, offsetSec: 0 }),
      userTurn({ toolResultText: "ok", offsetSec: 30 }),
    ];
    const report = diagnoseSession("s", turns);
    const categories = report.findings.map((f) => f.category);
    expect(categories).toContain("near-compaction");
    expect(categories).not.toContain("context-bloat");
  });

  it("emits context-bloat when fill is between 60% and 83%", () => {
    const turns = [
      assistantTurn({ inputTokens: 140_000, offsetSec: 0 }),
      userTurn({ toolResultText: "ok", offsetSec: 30 }),
    ];
    const report = diagnoseSession("s", turns);
    const categories = report.findings.map((f) => f.category);
    expect(categories).toContain("context-bloat");
    expect(categories).not.toContain("near-compaction");
  });

  it("emits cache-ttl-expiry on long inter-turn gaps", () => {
    const turns = [
      assistantTurn({ inputTokens: 10_000, offsetSec: 0 }),
      // 10-minute gap > 5-minute TTL. Two of them, so the count >= 1 path lights up.
      assistantTurn({ inputTokens: 10_000, offsetSec: 600 }),
      assistantTurn({ inputTokens: 10_000, offsetSec: 1300 }),
    ];
    const report = diagnoseSession("s", turns);
    expect(report.findings.some((f) => f.category === "cache-ttl-expiry")).toBe(true);
  });

  it("emits cache-thrash when 3+ cache_create spikes occur within 5 min", () => {
    const turns = [
      assistantTurn({ cacheCreateTokens: 10_000, offsetSec: 0 }),
      assistantTurn({ cacheCreateTokens: 10_000, offsetSec: 60 }),
      assistantTurn({ cacheCreateTokens: 10_000, offsetSec: 120 }),
    ];
    const report = diagnoseSession("s", turns);
    expect(report.findings.some((f) => f.category === "cache-thrash")).toBe(true);
  });

  it("emits compaction-loop when sessionQuality detects one", () => {
    const turns = [
      assistantTurn({ inputTokens: 160_000, offsetSec: 0 }),
      assistantTurn({ inputTokens: 161_000, offsetSec: 60 }),
      assistantTurn({ inputTokens: 160_500, offsetSec: 120 }),
    ];
    const report = diagnoseSession("s", turns);
    expect(report.findings.some((f) => f.category === "compaction-loop")).toBe(true);
  });

  it("infers outcome=stuck when a long failure streak is present", () => {
    const turns: UsageTurn[] = [];
    // 6 grace turns
    for (let i = 0; i < 6; i++) turns.push(assistantTurn({ offsetSec: i }));
    // 8-turn failure streak → exceeds STREAK_WINDOW_MIN of 8 in inferOutcome
    for (let i = 0; i < 8; i++) {
      turns.push(userTurn({ toolResultText: "Error: nope", offsetSec: 6 + i }));
    }
    const report = diagnoseSession("s", turns);
    expect(report.outcome).toBe("stuck");
  });

  it("topAdvice returns at most 3 strings", () => {
    const turns = [
      assistantTurn({ inputTokens: 175_000, cacheCreateTokens: 10_000, offsetSec: 0 }),
      assistantTurn({ inputTokens: 176_000, cacheCreateTokens: 10_000, offsetSec: 60 }),
      assistantTurn({ inputTokens: 175_500, cacheCreateTokens: 10_000, offsetSec: 120 }),
      // Long gap → cache TTL
      assistantTurn({ inputTokens: 50_000, offsetSec: 800 }),
    ];
    const report = diagnoseSession("s", turns);
    expect(report.topAdvice.length).toBeLessThanOrEqual(3);
  });

  it("infers outcome=abandoned when last turn is a user turn", () => {
    const turns = [
      assistantTurn({ inputTokens: 10_000, offsetSec: 0 }),
      userTurn({ toolResultText: "ok", offsetSec: 30 }),
    ];
    const report = diagnoseSession("s", turns);
    expect(report.outcome).toBe("abandoned");
  });

  it("infers outcome=completed when last turn is a clean assistant turn", () => {
    const turns = [
      userTurn({ offsetSec: 0 }),
      assistantTurn({ inputTokens: 10_000, offsetSec: 30 }),
    ];
    const report = diagnoseSession("s", turns);
    expect(report.outcome).toBe("completed");
  });
});
