import { describe, it, expect } from "vitest";
import {
  attributeContext,
  emptyCategoryTokens,
  CONTEXT_CATEGORIES,
  CONTEXT_CATEGORY_LABELS,
  type AttributionEntry,
} from "@/lib/usage/contextAttribution";

// Tests for `src/lib/usage/contextAttribution.ts`. Pure — no DB, no
// filesystem, no driver guard.
//
// BYTES_PER_TOKEN is 4, so a 400-char ASCII string estimates to 100
// tokens. Fixtures use round multiples of 4 so assertions can be exact
// rather than approximate.

const text = (n: number) => "x".repeat(n * 4); // n tokens' worth

function user(content: unknown, ts = "2026-01-01T00:00:00Z"): AttributionEntry {
  return { type: "user", timestamp: ts, message: { content } };
}

function assistant(
  content: unknown,
  usage?: Partial<NonNullable<NonNullable<AttributionEntry["message"]>["usage"]>>,
  ts = "2026-01-01T00:00:01Z"
): AttributionEntry {
  return { type: "assistant", timestamp: ts, message: { content, usage } };
}

describe("attributeContext", () => {
  describe("categorisation", () => {
    it("splits user prose, assistant prose, thinking, tool input and tool output", () => {
      const report = attributeContext("s", [
        user([{ type: "text", text: text(10) }]),
        assistant([
          { type: "text", text: text(20) },
          { type: "thinking", thinking: text(30) },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ]),
        user([{ type: "tool_result", tool_use_id: "t1", content: text(40) }]),
      ]);
      expect(report.totals.userText).toBe(10);
      expect(report.totals.assistantText).toBe(20);
      expect(report.totals.thinking).toBe(30);
      expect(report.totals.toolOutput).toBe(40);
      expect(report.totals.toolInput).toBeGreaterThan(0);
    });

    it("routes harness-injected user turns to attachedContext, not userText", () => {
      // A `<system-reminder>` is user-ROLE but not user-AUTHORED. Counting
      // it as "your prompts" makes the chart claim you typed tens of
      // thousands of characters you never typed.
      const report = attributeContext("s", [
        user([{ type: "text", text: "<system-reminder>" + text(25) + "</system-reminder>" }]),
        user([{ type: "text", text: text(5) }]),
      ]);
      expect(report.totals.attachedContext).toBeGreaterThan(0);
      expect(report.totals.userText).toBe(5);
    });

    it("handles string content as well as block arrays", () => {
      // Claude Code stores human-typed turns as a raw string on
      // message.content; array-only handling silently scores them zero.
      const report = attributeContext("s", [user(text(12))]);
      expect(report.totals.userText).toBe(12);
    });

    it("reads tool_result content in both string and block-array form", () => {
      const asString = attributeContext("s", [
        user([{ type: "tool_result", tool_use_id: "a", content: text(8) }]),
      ]);
      const asBlocks = attributeContext("s", [
        user([
          { type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: text(8) }] },
        ]),
      ]);
      expect(asString.totals.toolOutput).toBe(8);
      expect(asBlocks.totals.toolOutput).toBe(8);
    });

    it("survives unserializable tool input without failing the report", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const report = attributeContext("s", [
        assistant([
          { type: "text", text: text(7) },
          { type: "tool_use", id: "t", name: "X", input: circular },
        ]),
      ]);
      // Under-counting one block beats throwing away the whole session.
      expect(report.totals.assistantText).toBe(7);
      expect(report.totals.toolInput).toBe(0);
    });
  });

  describe("measured vs attributed", () => {
    it("reports the measured window size from the usage block", () => {
      const report = attributeContext("s", [
        assistant([{ type: "text", text: text(10) }], {
          input_tokens: 1000,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 500,
          output_tokens: 99,
        }),
      ]);
      // input + cache_read + cache_creation; output is NOT window content.
      expect(report.turns[0].measuredContextTokens).toBe(6500);
      expect(report.peakMeasuredTokens).toBe(6500);
    });

    it("exposes the harness-injected remainder as unattributedTokens", () => {
      // The system prompt, tool definitions, CLAUDE.md and skill bodies
      // never appear in the transcript, so attribution can only ever be a
      // lower bound. Surfacing the gap is what makes the chart honest.
      const report = attributeContext("s", [
        assistant([{ type: "text", text: text(100) }], {
          input_tokens: 50_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
      ]);
      expect(report.attributedTotal).toBe(100);
      // 50_000 - 0, NOT 50_000 - 100: the assistant's own reply is OUTPUT
      // and was never in the input window that measured 50_000.
      expect(report.segments[0].attributedAtPeak).toBe(0);
      expect(report.segments[0].unattributedTokens).toBe(50_000);
    });

    it("compares the peak against attribution AS OF the peak, not the segment total", () => {
      // The subtle bug this guards: `peakMeasuredTokens` is the window as
      // it was fed IN to one assistant turn, so it excludes that turn's
      // own output and every turn after it. Subtracting the whole-segment
      // total mixes two moments in time and always understates the
      // remainder — by at least the final response.
      const report = attributeContext("s", [
        user([{ type: "text", text: text(1_000) }]),
        // Peak measured here. Everything before it is 1_000 attributed.
        assistant([{ type: "text", text: text(700) }], { input_tokens: 10_000 }),
        // Plenty more attribution AFTER the peak; it must not be
        // subtracted from a measurement taken before it existed.
        user([{ type: "text", text: text(5_000) }]),
        assistant([{ type: "text", text: text(400) }], { input_tokens: 900 }),
      ]);
      const seg = report.segments[0];
      expect(seg.peakMeasuredTokens).toBe(10_000);
      expect(seg.attributedAtPeak).toBe(1_000);
      expect(seg.unattributedTokens).toBe(9_000);
      // The segment total is far larger; using it would have given 2_900.
      expect(seg.attributedTotal).toBe(7_100);
    });

    it("floors unattributedTokens at zero rather than showing negative", () => {
      // Over-attribution (the 4-bytes-per-token heuristic over-counting
      // dense text) must not render as "saved tokens". Needs content
      // BEFORE the peak turn, since that is what the peak is compared to.
      const report = attributeContext("s", [
        user([{ type: "text", text: text(10_000) }]),
        assistant([{ type: "text", text: text(1) }], { input_tokens: 5 }),
      ]);
      expect(report.segments[0].attributedAtPeak).toBe(10_000);
      expect(report.segments[0].unattributedTokens).toBe(0);
    });

    it("leaves measured fields null when no usage block is present", () => {
      const report = attributeContext("s", [user([{ type: "text", text: text(3) }])]);
      expect(report.turns[0].measuredContextTokens).toBeNull();
      expect(report.peakMeasuredTokens).toBeNull();
      expect(report.segments[0].unattributedTokens).toBeNull();
    });
  });

  describe("compaction segmentation", () => {
    it("starts a new segment at a compaction boundary", () => {
      // Cumulative context across a boundary is meaningless — the window
      // is discarded and rebuilt — so the series must restart.
      const report = attributeContext("s", [
        user([{ type: "text", text: text(10) }]),
        { subtype: "compact_boundary" },
        user([{ type: "text", text: text(20) }]),
      ]);
      expect(report.segments.length).toBe(2);
      expect(report.compactionCount).toBe(1);
      expect(report.segments[0].totals.userText).toBe(10);
      expect(report.segments[1].totals.userText).toBe(20);
      // Session-wide totals still sum across segments.
      expect(report.totals.userText).toBe(30);
    });

    it("recognises every established compaction marker shape", () => {
      // Claude Code has emitted at least four shapes across CLI versions
      // (see `readCompactionSummary` in sessionHandoff.ts). Missing one
      // means the report silently accumulates across a reset that really
      // happened — no error, just wrong segment peaks and cumulative bars.
      const shapes: AttributionEntry[][] = [
        [{ type: "system", subtype: "compact_boundary" }],
        [{ type: "compact_summary" }],
        [{ compactSummary: "summary text" }],
        [{ type: "system", content: "… [compact summary] …" }],
        [{ type: "system", content: "compact_boundary reached" }],
      ];
      for (const [marker] of shapes.map((x) => x)) {
        const report = attributeContext("s", [
          user([{ type: "text", text: text(1) }]),
          marker,
          user([{ type: "text", text: text(1) }]),
        ]);
        expect(report.compactionCount).toBe(1);
        expect(report.segments.length).toBe(2);
      }
    });

    it("does not treat an ordinary system message as a boundary", () => {
      // The shape-4 text check must not fire on unrelated system content.
      const report = attributeContext("s", [
        user([{ type: "text", text: text(1) }]),
        { type: "system", content: "just a normal system note" },
        user([{ type: "text", text: text(1) }]),
      ]);
      expect(report.compactionCount).toBe(0);
    });

    it("recognises the isCompactSummary boundary shape too", () => {
      // CLI versions mark compaction differently; pinning one shape would
      // silently stop segmenting after an upgrade.
      const report = attributeContext("s", [
        user([{ type: "text", text: text(1) }]),
        { isCompactSummary: true },
        user([{ type: "text", text: text(1) }]),
      ]);
      expect(report.compactionCount).toBe(1);
    });

    it("flags the first turn after a boundary", () => {
      const report = attributeContext("s", [
        user([{ type: "text", text: text(1) }]),
        { subtype: "compact_boundary" },
        user([{ type: "text", text: text(1) }]),
        user([{ type: "text", text: text(1) }]),
      ]);
      expect(report.turns[0].afterCompaction).toBe(false);
      expect(report.turns[1].afterCompaction).toBe(true);
      expect(report.turns[2].afterCompaction).toBe(false);
    });

    it("tracks peak fill per segment independently", () => {
      const report = attributeContext("s", [
        assistant([{ type: "text", text: text(1) }], { input_tokens: 90_000 }),
        { subtype: "compact_boundary" },
        assistant([{ type: "text", text: text(1) }], { input_tokens: 20_000 }),
      ]);
      expect(report.segments[0].peakMeasuredTokens).toBe(90_000);
      expect(report.segments[1].peakMeasuredTokens).toBe(20_000);
      expect(report.peakMeasuredTokens).toBe(90_000);
    });
  });

  describe("exclusions", () => {
    it("excludes sidechain turns — they occupy a separate window", () => {
      // Subagent tokens are billed and appear in usage totals, but they
      // were never in the PARENT session's context window. Folding them
      // in would inflate the parent's apparent fill.
      const report = attributeContext("s", [
        user([{ type: "text", text: text(10) }]),
        { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: text(999) }] } },
      ]);
      expect(report.totals.assistantText).toBe(0);
      expect(report.turns.length).toBe(1);
    });

    it("deduplicates re-emitted assistant messages by message.id", () => {
      // Claude Code re-logs an assistant message on retries and on
      // resumed-session re-emit. Counting each copy double-counts its
      // reply, thinking, and tool inputs — inflating exactly the sessions
      // most worth inspecting. The canonical parser guards this; a raw
      // -entry loop has to guard it too.
      const dup = {
        type: "assistant",
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          id: "msg_abc",
          content: [{ type: "text", text: text(50) }],
          usage: { input_tokens: 10 },
        },
      } as AttributionEntry;
      const report = attributeContext("s", [dup, dup]);
      expect(report.turns.length).toBe(1);
      expect(report.totals.assistantText).toBe(50);
    });

    it("falls back to requestId when message.id is absent", () => {
      const dup = {
        type: "assistant",
        timestamp: "2026-01-01T00:00:01Z",
        requestId: "req_xyz",
        message: { content: [{ type: "text", text: text(20) }] },
      } as AttributionEntry;
      const report = attributeContext("s", [dup, dup]);
      expect(report.turns.length).toBe(1);
      expect(report.totals.assistantText).toBe(20);
    });

    it("keeps distinct assistant messages that carry no id at all", () => {
      // Only ids actually present are guarded — otherwise genuinely
      // distinct turns would collapse into one.
      const report = attributeContext("s", [
        assistant([{ type: "text", text: text(10) }]),
        assistant([{ type: "text", text: text(10) }]),
      ]);
      expect(report.turns.length).toBe(2);
      expect(report.totals.assistantText).toBe(20);
    });

    it("excludes meta entries and non-turn entry types", () => {
      const report = attributeContext("s", [
        { type: "user", isMeta: true, message: { content: [{ type: "text", text: text(50) }] } },
        { type: "summary" },
        user([{ type: "text", text: text(4) }]),
      ]);
      expect(report.turns.length).toBe(1);
      expect(report.totals.userText).toBe(4);
    });
  });

  describe("summary fields", () => {
    it("identifies the dominant category and its share", () => {
      const report = attributeContext("s", [
        user([{ type: "tool_result", tool_use_id: "a", content: text(75) }]),
        user([{ type: "text", text: text(25) }]),
      ]);
      expect(report.dominantCategory).toBe("toolOutput");
      expect(report.dominantShare).toBeCloseTo(75, 5);
    });

    it("computes peak fill as a percentage of the context window", () => {
      const report = attributeContext("s", [
        assistant([{ type: "text", text: text(1) }], { input_tokens: 100_000 }),
      ], 200_000);
      expect(report.peakContextPercent).toBeCloseTo(50, 5);
    });

    it("clamps peak percent at 100 for over-window measurements", () => {
      const report = attributeContext("s", [
        assistant([{ type: "text", text: text(1) }], { input_tokens: 400_000 }),
      ], 200_000);
      expect(report.peakContextPercent).toBe(100);
    });
  });

  describe("degenerate input", () => {
    it("returns a well-formed empty report with one segment", () => {
      // Consumers index segments[0] unconditionally, so an empty session
      // must still produce one.
      const report = attributeContext("s", []);
      expect(report.turns).toEqual([]);
      expect(report.segments.length).toBe(1);
      expect(report.attributedTotal).toBe(0);
      expect(report.dominantCategory).toBeNull();
      expect(report.dominantShare).toBe(0);
      expect(report.peakMeasuredTokens).toBeNull();
      expect(report.compactionCount).toBe(0);
    });

    it("tolerates malformed content blocks", () => {
      const report = attributeContext("s", [
        user([null, undefined, 42, { type: "text" }, { type: "unknown-block" }] as unknown[]),
      ]);
      expect(report.attributedTotal).toBe(0);
      expect(report.turns.length).toBe(1);
    });
  });

  it("keeps labels in sync with the category union", () => {
    // A new category added without a label would render a blank legend.
    for (const c of CONTEXT_CATEGORIES) {
      expect(CONTEXT_CATEGORY_LABELS[c]).toBeTruthy();
    }
    expect(Object.keys(emptyCategoryTokens()).sort()).toEqual([...CONTEXT_CATEGORIES].sort());
  });
});
