import { describe, it, expect } from "vitest";
import {
  detectSelfCorrectionPerModel,
  textHasSelfCorrection,
  type SelfCorrectionReport,
} from "@/lib/usage/selfCorrection";
import type { UsageTurn } from "@/lib/usage/types";

function turn(args: Partial<UsageTurn> & {
  role: "user" | "assistant";
  sessionId: string;
  model?: string;
  text?: string;
}): UsageTurn {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    projectSlug: "p",
    projectDirName: "p",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    model: args.model ?? "claude-sonnet-4-6",
    assistantText: args.role === "assistant" ? args.text : undefined,
    userMessageText: args.role === "user" ? args.text : undefined,
    role: args.role,
    sessionId: args.sessionId,
  };
}

// ── textHasSelfCorrection ───────────────────────────────────────────────────

describe("textHasSelfCorrection", () => {
  it("matches simple correction phrases", () => {
    expect(textHasSelfCorrection("My mistake — let me try again.")).toBe(true);
    expect(textHasSelfCorrection("I was wrong about that.")).toBe(true);
    expect(textHasSelfCorrection("I apologize for the confusion.")).toBe(true);
    expect(textHasSelfCorrection("I apologise for the confusion.")).toBe(true);
    expect(textHasSelfCorrection("Let me reconsider this.")).toBe(true);
    expect(textHasSelfCorrection("I made an error there.")).toBe(true);
    expect(textHasSelfCorrection("I need to correct that.")).toBe(true);
  });

  it("matches \"actually,\" only when sentence-anchored", () => {
    // Mid-sentence "actually," is a noisy false positive — should NOT match.
    expect(textHasSelfCorrection("That works, actually, in most cases.")).toBe(false);
    // Sentence-start: matches.
    expect(textHasSelfCorrection("Actually, let me look at that again.")).toBe(true);
    expect(textHasSelfCorrection("Hmm. Actually, I missed something.")).toBe(true);
  });

  it("returns false on empty / no-correction text", () => {
    expect(textHasSelfCorrection("")).toBe(false);
    expect(textHasSelfCorrection("Looks good — proceeding to the next step.")).toBe(false);
  });
});

// ── detectSelfCorrectionPerModel ────────────────────────────────────────────

describe("detectSelfCorrectionPerModel", () => {
  function find(report: SelfCorrectionReport, model: string) {
    return report.byModel.find((m) => m.model === model);
  }

  it("attributes session to its primary (most-turn-wins) model", () => {
    const turns: UsageTurn[] = [
      turn({ role: "assistant", sessionId: "s1", model: "claude-opus-4-7", text: "hi" }),
      turn({ role: "assistant", sessionId: "s1", model: "claude-opus-4-7", text: "hi" }),
      turn({ role: "assistant", sessionId: "s1", model: "claude-opus-4-7", text: "hi" }),
      turn({ role: "assistant", sessionId: "s1", model: "claude-haiku-4-5", text: "I apologize, my mistake" }),
    ];
    const r = detectSelfCorrectionPerModel(turns);
    // Primary model = opus (3 turns) → opus is the corrected one.
    expect(find(r, "claude-opus-4-7")?.corrected).toBe(1);
    expect(find(r, "claude-opus-4-7")?.total).toBe(1);
    // haiku has no sessions where it was primary → not present.
    expect(find(r, "claude-haiku-4-5")).toBeUndefined();
  });

  it("dedupes per session — multiple correction phrases count once", () => {
    const turns: UsageTurn[] = [
      turn({ role: "assistant", sessionId: "s1", text: "I apologize." }),
      turn({ role: "assistant", sessionId: "s1", text: "My mistake!" }),
      turn({ role: "assistant", sessionId: "s1", text: "Let me reconsider." }),
    ];
    const r = detectSelfCorrectionPerModel(turns);
    expect(find(r, "claude-sonnet-4-6")?.corrected).toBe(1);
    expect(find(r, "claude-sonnet-4-6")?.total).toBe(1);
  });

  it("computes rate across multiple sessions", () => {
    const turns: UsageTurn[] = [
      turn({ role: "assistant", sessionId: "s1", text: "I apologize" }),
      turn({ role: "assistant", sessionId: "s2", text: "ok" }),
      turn({ role: "assistant", sessionId: "s3", text: "I made an error" }),
      turn({ role: "assistant", sessionId: "s4", text: "ok" }),
    ];
    const r = detectSelfCorrectionPerModel(turns);
    const stats = find(r, "claude-sonnet-4-6");
    expect(stats?.total).toBe(4);
    expect(stats?.corrected).toBe(2);
    expect(stats?.rate).toBeCloseTo(0.5);
  });

  it("ignores user turns", () => {
    const turns: UsageTurn[] = [
      turn({ role: "user", sessionId: "s1", text: "I apologize for nothing" }),
      turn({ role: "assistant", sessionId: "s1", text: "Looks fine." }),
    ];
    const r = detectSelfCorrectionPerModel(turns);
    expect(find(r, "claude-sonnet-4-6")?.corrected).toBe(0);
  });

  it("byModel is sorted by `total` descending and is a frozen array", () => {
    const turns: UsageTurn[] = [
      turn({ role: "assistant", sessionId: "s1", model: "claude-opus-4-7", text: "ok" }),
      turn({ role: "assistant", sessionId: "s2", model: "claude-haiku-4-5", text: "ok" }),
      turn({ role: "assistant", sessionId: "s3", model: "claude-haiku-4-5", text: "ok" }),
    ];
    const r = detectSelfCorrectionPerModel(turns);
    expect(r.byModel.map((m) => m.model)).toEqual(["claude-haiku-4-5", "claude-opus-4-7"]);
    expect(Object.isFrozen(r.byModel)).toBe(true);
  });
});

// ── Integration: aggregator wiring ──────────────────────────────────────────

describe("aggregator integration", () => {
  it("populates selfCorrectionRate on ModelCost rows", async () => {
    // Mirror the aggregator's path with a tiny in-memory fixture.
    const turns: UsageTurn[] = [
      turn({ role: "assistant", sessionId: "s1", text: "I apologize." }),
      turn({ role: "assistant", sessionId: "s2", text: "ok" }),
    ];
    const { aggregateUsage } = await import("@/lib/usage/aggregator");
    const report = await aggregateUsage(turns, "all");
    const sonnet = report.byModel.find((m) => m.model === "claude-sonnet-4-6");
    expect(sonnet?.selfCorrectionRate).toBeCloseTo(0.5);
    expect(sonnet?.sessionsAsPrimary).toBe(2);
  });
});
