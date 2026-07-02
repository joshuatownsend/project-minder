import { describe, it, expect, beforeEach } from "vitest";
import {
  computeCacheStats,
  detectCompactionLoops,
  detectToolFailureStreaks,
  detectStuckLoops,
  computeSessionQuality,
  getModelContextWindow,
  turnContextFill,
  _resetWarnedModelsForTesting,
} from "@/lib/usage/sessionQuality";
import type { UsageTurn } from "@/lib/usage/types";
import { assistantTurn as assistant, userTurn as user } from "./fixtures/turn";

beforeEach(() => {
  _resetWarnedModelsForTesting();
});

describe("getModelContextWindow", () => {
  it("returns 200K for standard claude-sonnet-4-6", () => {
    expect(getModelContextWindow("claude-sonnet-4-6")).toBe(200_000);
  });

  it("returns 1M when [1m] suffix is present", () => {
    expect(getModelContextWindow("claude-sonnet-4-7[1m]")).toBe(1_000_000);
  });

  it("returns 1M by default for Fable 5, Mythos 5, and Sonnet 5", () => {
    expect(getModelContextWindow("claude-fable-5")).toBe(1_000_000);
    expect(getModelContextWindow("claude-mythos-5")).toBe(1_000_000);
    expect(getModelContextWindow("claude-sonnet-5")).toBe(1_000_000);
  });

  it("returns 1M by default for the current Opus line (4.6/4.7/4.8)", () => {
    expect(getModelContextWindow("claude-opus-4-6")).toBe(1_000_000);
    expect(getModelContextWindow("claude-opus-4-7")).toBe(1_000_000);
    expect(getModelContextWindow("claude-opus-4-8")).toBe(1_000_000);
    // The [1m] suffix path still wins for these too.
    expect(getModelContextWindow("claude-opus-4-8[1m]")).toBe(1_000_000);
  });

  it("does not warn for Fable 5 (previously an unknown model)", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);
    try {
      expect(getModelContextWindow("claude-fable-5")).toBe(1_000_000);
      expect(warnings.length).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("keeps 200K for haiku and the opt-in-1M SKUs (Sonnet 4.x, Opus 4.5)", () => {
    expect(getModelContextWindow("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(getModelContextWindow("claude-sonnet-4-6")).toBe(200_000);
    expect(getModelContextWindow("claude-opus-4-5")).toBe(200_000);
    // ...unless the [1m] suffix opts in.
    expect(getModelContextWindow("claude-sonnet-4-6[1m]")).toBe(1_000_000);
  });

  it("returns 100K for legacy claude-2 family", () => {
    expect(getModelContextWindow("claude-2.1")).toBe(100_000);
  });

  it("falls back to 200K and warns once for unknown models", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);
    try {
      expect(getModelContextWindow("gpt-5")).toBe(200_000);
      expect(getModelContextWindow("gpt-5")).toBe(200_000);
      expect(warnings.length).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("returns the default for empty model string without warning", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);
    try {
      expect(getModelContextWindow("")).toBe(200_000);
      expect(warnings.length).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("computeCacheStats", () => {
  it("returns null hit ratio when no cache activity exists", () => {
    const turns = [assistant({ inputTokens: 100, outputTokens: 50 })];
    const stats = computeCacheStats(turns);
    expect(stats.hitRatio).toBeNull();
    expect(stats.cacheReadTokens).toBe(0);
    expect(stats.cacheCreateTokens).toBe(0);
  });

  it("computes ratio across assistant turns and ignores user turns", () => {
    const turns = [
      assistant({ cacheReadTokens: 0, cacheCreateTokens: 1000 }),
      user({ toolResultText: "ok" }),
      assistant({ cacheReadTokens: 700, cacheCreateTokens: 0 }),
    ];
    const stats = computeCacheStats(turns);
    // 700 / (700 + 1000) = ~0.4118
    expect(stats.hitRatio).toBeCloseTo(700 / 1700, 4);
    expect(stats.cacheReadTokens).toBe(700);
    expect(stats.cacheCreateTokens).toBe(1000);
  });

  it("rebuildWasteUsd is positive when build cost exceeds read savings", () => {
    const turns = [
      assistant({ model: "claude-sonnet-4-6", cacheCreateTokens: 1_000_000, cacheReadTokens: 0 }),
    ];
    const stats = computeCacheStats(turns);
    expect(stats.rebuildWasteUsd).toBeGreaterThan(0);
  });

  it("rebuildWasteUsd can be negative when reads paid back the build", () => {
    const turns = [
      assistant({ model: "claude-sonnet-4-6", cacheCreateTokens: 0, cacheReadTokens: 10_000_000 }),
    ];
    const stats = computeCacheStats(turns);
    expect(stats.rebuildWasteUsd).toBeLessThan(0);
  });
});

describe("detectCompactionLoops", () => {
  it("emits no findings on a healthy session with low fill", () => {
    const turns = [
      assistant({ inputTokens: 10_000 }),
      assistant({ inputTokens: 11_000 }),
      assistant({ inputTokens: 12_000 }),
    ];
    expect(detectCompactionLoops(turns)).toEqual([]);
  });

  it("detects a loop when consecutive turns sit above 75% fill with low variance", () => {
    // 200K window, 160K = 80% fill. Variance < 10%.
    const turns = [
      assistant({ inputTokens: 160_000 }),
      assistant({ inputTokens: 162_000 }),
      assistant({ inputTokens: 161_000 }),
    ];
    const findings = detectCompactionLoops(turns);
    expect(findings.length).toBe(1);
    expect(findings[0].pairCount).toBe(2);
    expect(findings[0].peakFill).toBeGreaterThan(0.75);
  });

  it("does not flag high-variance turns as a loop", () => {
    // High fill but variance is huge — Claude IS doing work, not looping.
    const turns = [
      assistant({ inputTokens: 160_000 }),
      assistant({ inputTokens: 100_000 }),
    ];
    expect(detectCompactionLoops(turns)).toEqual([]);
  });

  it("requires fill >75% even when variance is low", () => {
    // Steady-state at 50% fill is just steady work, not a loop.
    const turns = [
      assistant({ inputTokens: 100_000 }),
      assistant({ inputTokens: 101_000 }),
      assistant({ inputTokens: 100_500 }),
    ];
    expect(detectCompactionLoops(turns)).toEqual([]);
  });

  it("ignores user turns and synthetic-model turns when computing pairs", () => {
    const turns = [
      assistant({ inputTokens: 160_000 }),
      user({ toolResultText: "ok" }),
      assistant({ inputTokens: 162_000 }),
    ];
    const findings = detectCompactionLoops(turns);
    expect(findings.length).toBe(1);
    expect(findings[0].pairCount).toBe(1);
  });
});

describe("detectToolFailureStreaks", () => {
  it("returns no streaks when fewer than 5 evaluable turns exist", () => {
    const turns = [
      ...Array.from({ length: 6 }, () => assistant({})), // grace turns
      user({ toolResultText: "Error: foo" }),
      user({ toolResultText: "Error: bar" }),
    ];
    expect(detectToolFailureStreaks(turns)).toEqual([]);
  });

  it("flags 5 consecutive errored tool results past the grace window", () => {
    const turns: UsageTurn[] = [
      ...Array.from({ length: 6 }, () => assistant({})),
      user({ toolResultText: "Error: nope" }),
      user({ toolResultText: "failed to apply" }),
      user({ toolResultText: "Error: nope" }),
      user({ toolResultText: "not found" }),
      user({ toolResultText: "Error: nope" }),
    ];
    const streaks = detectToolFailureStreaks(turns);
    expect(streaks.length).toBe(1);
    expect(streaks[0].failureRate).toBe(1.0);
    expect(streaks[0].windowSize).toBe(5);
  });

  it("respects the first-6-turns grace by skipping early errors", () => {
    const turns = [
      // 6 grace turns, all errored — must not contribute to a streak.
      ...Array.from({ length: 6 }, () => user({ toolResultText: "Error: ignore me" })),
      user({ toolResultText: "ok" }),
      user({ toolResultText: "ok" }),
    ];
    expect(detectToolFailureStreaks(turns)).toEqual([]);
  });

  it("treats <50% rate as not-a-streak", () => {
    const turns = [
      ...Array.from({ length: 6 }, () => assistant({})),
      user({ toolResultText: "Error: a" }),
      user({ toolResultText: "ok" }),
      user({ toolResultText: "ok" }),
      user({ toolResultText: "ok" }),
      user({ toolResultText: "Error: b" }),
    ];
    expect(detectToolFailureStreaks(turns)).toEqual([]);
  });

  it("detects errors that appear early in a long, truncated toolResultText", () => {
    // The parser slices toolResultText at 2000 chars; a streak detector that
    // missed errors near the truncation boundary would underreport. The
    // ERROR_MARKER_RE looks for substrings, so coverage of an early-line
    // marker is the realistic guarantee.
    const longBody = "Error: something went wrong\n" + "x".repeat(1900);
    const turns = [
      ...Array.from({ length: 6 }, () => assistant({})),
      user({ toolResultText: longBody }),
      user({ toolResultText: longBody }),
      user({ toolResultText: longBody }),
      user({ toolResultText: longBody }),
      user({ toolResultText: longBody }),
    ];
    const streaks = detectToolFailureStreaks(turns);
    expect(streaks.length).toBe(1);
    expect(streaks[0].failureCount).toBe(5);
  });

  it("counts assistant turns with isError=true alongside user error results", () => {
    const turns = [
      ...Array.from({ length: 6 }, () => assistant({})),
      assistant({ isError: true }),
      user({ toolResultText: "Error: x" }),
      assistant({ isError: true }),
      user({ toolResultText: "failed" }),
      assistant({ isError: true }),
    ];
    const streaks = detectToolFailureStreaks(turns);
    expect(streaks.length).toBe(1);
    expect(streaks[0].failureRate).toBe(1.0);
  });
});

describe("computeSessionQuality + turnContextFill", () => {
  it("turnContextFill returns null for user turns", () => {
    expect(turnContextFill(user({}))).toBeNull();
  });

  it("turnContextFill returns null when input tokens are zero", () => {
    expect(turnContextFill(assistant({ inputTokens: 0 }))).toBeNull();
  });

  it("turnContextFill divides input by the model context window", () => {
    expect(
      turnContextFill(assistant({ model: "claude-sonnet-4-6", inputTokens: 100_000 }))
    ).toBeCloseTo(0.5, 4);
  });

  it("turnContextFill measures uncached input only — cache-aware sessions show low fill", () => {
    // Per TODO #102's spec: a heavily-cached healthy session with
    // 388 input_tokens and 60K cache_read should fill at ~0.2%
    // (just the new tokens this turn). The compaction-loop detector
    // intentionally fires on HIGH input_tokens (cache failing) — see
    // module comment for the rationale.
    expect(
      turnContextFill(
        assistant({
          model: "claude-sonnet-4-6",
          inputTokens: 388,
          cacheReadTokens: 60_000,
          cacheCreateTokens: 0,
        })
      )
    ).toBeCloseTo(388 / 200_000, 4);
  });

  it("detectCompactionLoops fires when input_tokens stays high (cache failing)", () => {
    // High input_tokens (160K) means the model is reading new content
    // every turn — cache isn't working. Three such consecutive turns
    // with low variance signals a real compaction loop.
    const turns = [
      assistant({ inputTokens: 160_000, cacheReadTokens: 0 }),
      assistant({ inputTokens: 161_000, cacheReadTokens: 0 }),
      assistant({ inputTokens: 160_500, cacheReadTokens: 0 }),
    ];
    const findings = computeSessionQuality(turns).compactionLoops;
    expect(findings.length).toBe(1);
    expect(findings[0].peakFill).toBeGreaterThan(0.75);
  });

  it("detectCompactionLoops does NOT fire on healthy heavily-cached sessions", () => {
    // Same total context (~160K loaded) but split as low input_tokens
    // and high cache_read — the cache is doing its job. The loop
    // detector should stay silent.
    const turns = [
      assistant({ inputTokens: 100, cacheReadTokens: 159_000 }),
      assistant({ inputTokens: 100, cacheReadTokens: 161_000 }),
      assistant({ inputTokens: 100, cacheReadTokens: 160_000 }),
    ];
    expect(computeSessionQuality(turns).compactionLoops).toEqual([]);
  });

  it("computeSessionQuality returns the bundled summary in one pass", () => {
    const turns = [
      assistant({ inputTokens: 160_000, cacheCreateTokens: 1000, cacheReadTokens: 700 }),
      assistant({ inputTokens: 162_000, cacheCreateTokens: 1000, cacheReadTokens: 700 }),
      assistant({ inputTokens: 161_000, cacheCreateTokens: 1000, cacheReadTokens: 700 }),
    ];
    const summary = computeSessionQuality(turns);
    expect(summary.cache.hitRatio).toBeCloseTo(0.4118, 3);
    expect(summary.compactionLoops.length).toBe(1);
    expect(summary.toolFailureStreaks).toEqual([]);
    expect(summary.maxContextFill).toBeGreaterThan(0.75);
  });

  it("golden vector: all 4 detectors firing in one mixed session", () => {
    // Pinned-output baseline captured from the current per-detector
    // implementation. Exists so any future single-pass fusion of the
    // walk loop can be validated byte-equal — a subtle ordering or
    // window-boundary bug in the refactor would surface here.
    //
    // The fixture is deliberately mixed:
    //   - turns 0..5  : 6 turns of grace (streak detector skips first 6)
    //   - turns 6..14 : 9 user turns carrying tool_result text — 6 are
    //                   error-bearing, 3 are clean → a 9-turn streak
    //                   with 6/9 ≈ 0.67 failure rate (>0.5 threshold)
    //   - turns 15..19: 5 high-input assistant turns with low variance
    //                   and ~80% fill → compaction-loop run of 4 pairs
    //   - turns 20..24: 5 healthy heavy-cache assistant turns to seed
    //                   cache hit-ratio above 0
    const turns: UsageTurn[] = [];
    // grace block — 3 user / 3 assistant alternating, no tool-result text
    for (let i = 0; i < 3; i++) {
      turns.push(user({ inputTokens: 50 }));
      turns.push(assistant({ inputTokens: 1000, cacheReadTokens: 0, cacheCreateTokens: 0 }));
    }
    // tool-failure streak — 9 user turns with toolResultText, mostly errors
    const errorMarkers = ["Error: nope", "operation failed", "file not found"];
    const cleanMarkers = ["ok", "completed", "done"];
    for (let i = 0; i < 9; i++) {
      // 6 errors, 3 clean — interleaved
      const text = i % 3 === 2 ? cleanMarkers[Math.floor(i / 3)] : errorMarkers[i % 3];
      turns.push(user({ inputTokens: 100, toolResultText: text }));
    }
    // compaction-loop run — 5 high-input assistant turns
    for (let i = 0; i < 5; i++) {
      turns.push(
        assistant({
          inputTokens: 160_000 + i * 200, // <10% variance
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
        }),
      );
    }
    // healthy cached assistant turns
    for (let i = 0; i < 5; i++) {
      turns.push(
        assistant({
          inputTokens: 200,
          cacheReadTokens: 50_000,
          cacheCreateTokens: 5_000,
        }),
      );
    }

    const summary = computeSessionQuality(turns);

    // cache: 5 assistant grace turns contribute 0/0; 5 compaction turns
    // contribute 0/0 (no cache); 5 healthy turns contribute 50K read +
    // 5K create each → 250K read / 25K create total.
    expect(summary.cache.cacheReadTokens).toBe(250_000);
    expect(summary.cache.cacheCreateTokens).toBe(25_000);
    expect(summary.cache.hitRatio).toBeCloseTo(250_000 / 275_000, 4);

    // compaction: one run spanning all 5 high-input turns → 4 qualifying pairs
    expect(summary.compactionLoops.length).toBe(1);
    expect(summary.compactionLoops[0].pairCount).toBe(4);
    expect(summary.compactionLoops[0].peakFill).toBeGreaterThan(0.8);

    // tool-failure streak: 9 evaluable turns, 6 errors → 1 finding,
    // failure rate ≈ 0.67
    expect(summary.toolFailureStreaks.length).toBe(1);
    expect(summary.toolFailureStreaks[0].windowSize).toBe(9);
    expect(summary.toolFailureStreaks[0].failureCount).toBe(6);
    expect(summary.toolFailureStreaks[0].failureRate).toBeCloseTo(6 / 9, 4);

    // max fill: peak input is 160_800 / 200_000 = 0.804
    expect(summary.maxContextFill).toBeCloseTo(160_800 / 200_000, 4);

    // stuck loops: no repeated tool calls in this fixture → none
    expect(summary.stuckLoops).toEqual([]);
  });
});

describe("detectStuckLoops", () => {
  // A "tool action" row = one assistant turn issuing ≥1 tool call, paired with
  // the result text of the following user turn. The detector fires on a run of
  // 3+ rows with identical (tool signature, result).
  const bash = (cmd: string) =>
    assistant({ toolCalls: [{ name: "Bash", arguments: { command: cmd } }] });
  const result = (text: string) => user({ toolResultText: text });

  it("fires on 3 identical call+result repeats", () => {
    const turns = [
      bash("npm test"), result("FAIL: 1 test"),
      bash("npm test"), result("FAIL: 1 test"),
      bash("npm test"), result("FAIL: 1 test"),
    ];
    const findings = detectStuckLoops(turns);
    expect(findings.length).toBe(1);
    expect(findings[0]).toMatchObject({ tool: "Bash", repeatCount: 3, startIndex: 0, endIndex: 4 });
  });

  it("does NOT fire when results differ across repeats", () => {
    const turns = [
      bash("npm test"), result("FAIL: test A"),
      bash("npm test"), result("FAIL: test B"),
      bash("npm test"), result("FAIL: test C"),
    ];
    expect(detectStuckLoops(turns)).toEqual([]);
  });

  it("does NOT fire when arguments differ across repeats", () => {
    const turns = [
      bash("ls a"), result("same"),
      bash("ls b"), result("same"),
      bash("ls c"), result("same"),
    ];
    expect(detectStuckLoops(turns)).toEqual([]);
  });

  it("does NOT fire below the 3-repeat threshold", () => {
    const turns = [
      bash("npm test"), result("FAIL"),
      bash("npm test"), result("FAIL"),
    ];
    expect(detectStuckLoops(turns)).toEqual([]);
  });

  it("treats interleaved tool-less assistant turns as non-breaking", () => {
    // A commentary turn (no tool calls) between identical calls does not
    // reset the run — the projection only contains tool-issuing turns.
    const turns = [
      bash("npm test"), result("FAIL"),
      assistant({ assistantText: "let me try again" }),
      bash("npm test"), result("FAIL"),
      bash("npm test"), result("FAIL"),
    ];
    const findings = detectStuckLoops(turns);
    expect(findings.length).toBe(1);
    expect(findings[0].repeatCount).toBe(3);
    expect(findings[0].startIndex).toBe(0);
    // endIndex is the last tool-issuing assistant turn (index 5), not the
    // trailing result turn (index 6).
    expect(findings[0].endIndex).toBe(5);
  });

  it("argument key order does not affect equality", () => {
    const turns = [
      assistant({ toolCalls: [{ name: "Grep", arguments: { a: 1, b: 2 } }] }), result("none"),
      assistant({ toolCalls: [{ name: "Grep", arguments: { b: 2, a: 1 } }] }), result("none"),
      assistant({ toolCalls: [{ name: "Grep", arguments: { a: 1, b: 2 } }] }), result("none"),
    ];
    expect(detectStuckLoops(turns).length).toBe(1);
  });

  it("computeSessionQuality reports the same stuck loops as the standalone detector", () => {
    const turns = [
      bash("npm test"), result("FAIL"),
      bash("npm test"), result("FAIL"),
      bash("npm test"), result("FAIL"),
    ];
    expect(computeSessionQuality(turns).stuckLoops).toEqual(detectStuckLoops(turns));
  });

  // ── PR #183 review fixes ─────────────────────────────────────────────────
  const humanPrompt = (text: string) => user({ userMessageText: text });

  it("does NOT fire when a human prompt separates the reruns (user-driven, not a loop)", () => {
    // The user explicitly asks for each rerun — the model isn't spinning on its
    // own, so a human prompt barriers the run.
    const turns = [
      bash("npm test"), result("FAIL"),
      humanPrompt("run it again"),
      bash("npm test"), result("FAIL"),
      humanPrompt("again please"),
      bash("npm test"), result("FAIL"),
    ];
    expect(detectStuckLoops(turns)).toEqual([]);
  });

  it("does NOT fire when no tool results were observed (missing ≠ identical)", () => {
    // Three identical calls with no captured tool_result — we can't confirm
    // identical OUTPUT, so it must not be treated as a loop.
    const turns = [bash("npm test"), bash("npm test"), bash("npm test")];
    expect(detectStuckLoops(turns)).toEqual([]);
  });

  it("does NOT fire on truncated results that merely share a prefix", () => {
    // Results at the 2KB preview cap are likely truncated; different long
    // outputs can share the captured prefix, so they can't anchor a loop.
    const capped = "X".repeat(2000);
    const turns = [
      bash("npm test"), result(capped),
      bash("npm test"), result(capped),
      bash("npm test"), result(capped),
    ];
    expect(detectStuckLoops(turns)).toEqual([]);
  });

  it("still fires on identical whitespace-only results (observed, not missing)", () => {
    // A whitespace result trims to "" but was genuinely observed — distinct
    // from a missing result, so an identical-call run still counts.
    const turns = [
      bash("ls"), result("   "),
      bash("ls"), result("  "),
      bash("ls"), result(" "),
    ];
    expect(detectStuckLoops(turns).length).toBe(1);
  });
});
