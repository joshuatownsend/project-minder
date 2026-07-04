import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseSessionTurns } from "@/lib/usage/parser";
import { aggregateUsage } from "@/lib/usage/aggregator";
import { classifyTurn } from "@/lib/usage/classifier";
import { applyPricing } from "@/lib/usage/costCalculator";
import { detectOneShot } from "@/lib/usage/oneShotDetector";
import { emptyActivity, toLocalDateStr } from "@/lib/usage/activityBuckets";
import type { ModelPricing, UsageTurn } from "@/lib/usage/types";

// ── Shared helpers ───────────────────────────────────────────────────────────

function makeTurn(overrides: Partial<UsageTurn> = {}): UsageTurn {
  return {
    timestamp: "2025-01-01T12:00:00Z",
    sessionId: "s1",
    projectSlug: "project-a",
    projectDirName: "C--project-a",
    model: "claude-sonnet-4",
    role: "assistant",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    source: "claude",
    ...overrides,
  };
}

async function withTempSession(
  lines: unknown[],
  fn: (turns: UsageTurn[], filePath: string) => Promise<void> | void,
  opts?: { includeSidechains?: boolean }
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minder-acc-"));
  const file = path.join(dir, "sess.jsonl");
  try {
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const turns = await parseSessionTurns(file, "C--project-a", opts);
    await fn(turns, file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ── A1: subagent (sidechain) tokens folded into totals ───────────────────────

describe("A1 — subagent tokens included in totals", () => {
  it("folds a sidechain assistant turn's tokens/cost into totalTokens and breaks it out", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ sessionId: "s1", inputTokens: 100, outputTokens: 50 }),
      makeTurn({
        sessionId: "s1",
        inputTokens: 400,
        outputTokens: 200,
        isSidechain: true,
        parentToolUseId: "task-1",
      }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());

    // Both turns' tokens are in the grand total.
    expect(report.totalTokens).toBe(100 + 50 + 400 + 200);
    // Subagent tokens are broken out.
    expect(report.subagentTokens).toBe(400 + 200);
    expect(report.subagentCost).toBeGreaterThan(0);
    // The subagent cost is folded into (and smaller than) the headline cost.
    expect(report.subagentCost).toBeLessThan(report.totalCost);
    // byModel turn count includes the subagent turn.
    const model = report.byModel.find((m) => m.model === "claude-sonnet-4");
    expect(model?.turns).toBe(2);
  });

  it("excludes subagent turns from tool stats and one-shot detection", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ sessionId: "s1", toolCalls: [{ name: "Read", arguments: {} }] }),
      makeTurn({
        sessionId: "s1",
        isSidechain: true,
        toolCalls: [{ name: "Bash", arguments: { command: "ls" } }],
      }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());
    const toolNames = report.topTools.map(([n]) => n);
    expect(toolNames).toContain("Read");
    expect(toolNames).not.toContain("Bash"); // subagent tool excluded
  });

  it("tags sidechain USER turns so the primary-only filter can strip them", async () => {
    // parseSessionTurns is the parser buildAllSessions uses; parseAllSessions
    // strips subagent turns by the isSidechain tag. Previously only assistant
    // sidechain turns were tagged, so subagent user/tool_result turns leaked
    // into primary-only consumers (one-shot/yield/session flows).
    await withTempSession(
      [
        {
          type: "user",
          timestamp: "2025-01-01T12:00:00Z",
          isSidechain: true,
          message: { role: "user", content: [{ type: "text", text: "subagent prompt" }] },
        },
        {
          type: "assistant",
          timestamp: "2025-01-01T12:00:01Z",
          isSidechain: true,
          message: {
            model: "claude-sonnet-4",
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [{ type: "text", text: "subagent reply" }],
          },
        },
      ],
      (turns) => {
        const userTurns = turns.filter((t) => t.role === "user");
        expect(userTurns).toHaveLength(1);
        expect(userTurns[0].isSidechain).toBe(true);
        // The primary-only filter parseAllSessions applies now drops every turn.
        expect(turns.filter((t) => !t.isSidechain)).toHaveLength(0);
      },
      { includeSidechains: true }
    );
  });
});

// ── A2: daily buckets use LOCAL date ─────────────────────────────────────────

describe("A2 — daily buckets use local date", () => {
  it("keys the daily bucket by the local calendar date, not the UTC slice", async () => {
    const ts = "2025-01-01T02:30:00Z";
    const turns: UsageTurn[] = [makeTurn({ timestamp: ts })];
    const report = await aggregateUsage(turns, "all", emptyActivity());
    expect(report.daily).toHaveLength(1);
    expect(report.daily[0].date).toBe(toLocalDateStr(ts));
  });
});

// ── A3: intent propagated onto the following assistant turn ──────────────────

describe("A3 — intent categories attribute assistant cost", () => {
  it("classifier reads propagated userIntentText on a token-bearing assistant turn", () => {
    const turn = makeTurn({
      userIntentText: "debug this crash",
      toolCalls: [{ name: "Bash", arguments: { command: "node app.js" } }],
    });
    expect(classifyTurn(turn)).toBe("Debugging");
  });

  it("parser threads the preceding user prompt onto the assistant turn", async () => {
    await withTempSession(
      [
        { type: "user", timestamp: "2025-01-01T12:00:00Z", message: { content: "debug this crash" } },
        {
          type: "assistant",
          timestamp: "2025-01-01T12:00:01Z",
          message: {
            id: "m1",
            model: "claude-sonnet-4",
            usage: { input_tokens: 100, output_tokens: 50 },
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "node app.js" } }],
          },
        },
      ],
      (turns) => {
        const assistant = turns.find((t) => t.role === "assistant")!;
        expect(assistant.userIntentText).toBe("debug this crash");
        expect(classifyTurn(assistant)).toBe("Debugging");
      }
    );
  });

  it("aggregator attributes the assistant turn's cost to Debugging via intent", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ role: "user", model: "", inputTokens: 0, outputTokens: 0, userMessageText: "debug this crash" }),
      makeTurn({
        userIntentText: "debug this crash",
        toolCalls: [{ name: "Bash", arguments: { command: "node app.js" } }],
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());
    const debugging = report.byCategory.find((c) => c.category === "Debugging");
    expect(debugging).toBeDefined();
    expect(debugging!.cost).toBeGreaterThan(0);
  });
});

// ── A4: >200k tiered pricing ─────────────────────────────────────────────────

describe("A4 — tiered >200k pricing", () => {
  const tiered: ModelPricing = {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheWriteCostPerToken: 0,
    cacheReadCostPerToken: 0,
    inputCostPerTokenAbove200k: 0.000006, // 2× surcharge above 200k
    outputCostPerTokenAbove200k: 0.0000225,
  };

  it("splits input cost at the 200k boundary", () => {
    const cost = applyPricing(tiered, {
      inputTokens: 300_000,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    });
    // 200k @ base + 100k @ surcharge
    const expected = 200_000 * 0.000003 + 100_000 * 0.000006;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it("falls back to flat pricing when no tier is defined", () => {
    const flat: ModelPricing = {
      inputCostPerToken: 0.000003,
      outputCostPerToken: 0.000015,
      cacheWriteCostPerToken: 0,
      cacheReadCostPerToken: 0,
    };
    const cost = applyPricing(flat, {
      inputTokens: 300_000,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    });
    expect(cost).toBeCloseTo(300_000 * 0.000003, 8);
  });
});

// ── A5: per-category one-shot doesn't cross session boundaries ───────────────

describe("A5 — one-shot detection is session-scoped", () => {
  it("detectOneShot would cross-pair two sessions' turns when naively concatenated", () => {
    // Session A: an edit with NO verification of its own.
    const sessA: UsageTurn[] = [
      makeTurn({ sessionId: "A", role: "assistant", toolCalls: [{ name: "Edit", arguments: { file_path: "a.ts" } }] }),
    ];
    // Session B: a standalone verification + passing result.
    const sessB: UsageTurn[] = [
      makeTurn({ sessionId: "B", role: "assistant", toolCalls: [{ name: "Bash", arguments: { command: "npm test" } }] }),
      makeTurn({ sessionId: "B", role: "user", model: "", inputTokens: 0, outputTokens: 0, toolResultText: "ok" }),
    ];
    // Naive concat lets A's edit pair with B's verification → 1 verified task.
    const crossed = detectOneShot([...sessA, ...sessB]);
    // Per-session, neither session has a complete edit→verify→result chain.
    const perSession =
      detectOneShot(sessA).totalVerifiedTasks + detectOneShot(sessB).totalVerifiedTasks;
    expect(crossed.totalVerifiedTasks).toBeGreaterThan(perSession);
    expect(perSession).toBe(0);
  });

  it("aggregator produces category one-shot without cross-session inflation", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ sessionId: "A", toolCalls: [{ name: "Edit", arguments: { file_path: "a.ts" } }] }),
      makeTurn({ sessionId: "B", toolCalls: [{ name: "Bash", arguments: { command: "npm test" } }] }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());
    // No fabricated verified task pairs across sessions.
    expect(report.oneShot.totalVerifiedTasks).toBe(0);
  });
});

// ── A6: dedup by message.id ──────────────────────────────────────────────────

describe("A6 — usage dedup by message.id", () => {
  it("counts a duplicated message.id only once", async () => {
    const assistant = {
      type: "assistant",
      timestamp: "2025-01-01T12:00:00Z",
      message: {
        id: "dup-1",
        model: "claude-sonnet-4",
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: "text", text: "hi" }],
      },
    };
    await withTempSession([assistant, assistant], (turns) => {
      const assistants = turns.filter((t) => t.role === "assistant");
      expect(assistants).toHaveLength(1);
      expect(assistants[0].inputTokens).toBe(100);
    });
  });

  it("keeps distinct message ids", async () => {
    await withTempSession(
      [
        { type: "assistant", timestamp: "2025-01-01T12:00:00Z", message: { id: "a", model: "claude-sonnet-4", usage: { input_tokens: 10, output_tokens: 5 }, content: [] } },
        { type: "assistant", timestamp: "2025-01-01T12:00:01Z", message: { id: "b", model: "claude-sonnet-4", usage: { input_tokens: 10, output_tokens: 5 }, content: [] } },
      ],
      (turns) => {
        expect(turns.filter((t) => t.role === "assistant")).toHaveLength(2);
      }
    );
  });
});

// ── A7: cache-hit-rate denominator includes cache writes ─────────────────────

describe("A7 — cache-hit-rate denominator", () => {
  it("includes cache-write tokens in the denominator", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 100, cacheCreateTokens: 100 }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());
    // 100 / (100 read + 100 input + 100 write)
    expect(report.cacheHitRate).toBeCloseTo(100 / 300, 8);
  });
});
