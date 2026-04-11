import { describe, it, expect } from "vitest";
import {
  insightId,
  parseInsightsFromJsonl,
  parseInsightsMd,
} from "@/lib/scanner/insightsMd";

describe("insightId", () => {
  it("returns a 12-character hex string", () => {
    const id = insightId("some content");
    expect(id).toMatch(/^[a-f0-9]{12}$/);
  });

  it("is deterministic", () => {
    expect(insightId("hello")).toBe(insightId("hello"));
  });

  it("trims whitespace before hashing", () => {
    expect(insightId("  hello  ")).toBe(insightId("hello"));
  });

  it("produces different IDs for different content", () => {
    expect(insightId("alpha")).not.toBe(insightId("beta"));
  });
});

describe("parseInsightsFromJsonl", () => {
  const makeJsonl = (
    lines: { type: string; timestamp?: string; text: string }[]
  ) =>
    lines
      .map((l) =>
        JSON.stringify({
          type: l.type,
          timestamp: l.timestamp ?? "2026-04-10T12:00:00Z",
          message: {
            content: [{ type: "text", text: l.text }],
          },
        })
      )
      .join("\n");

  it("extracts insight from ★ marker", () => {
    const jsonl = makeJsonl([
      {
        type: "assistant",
        text: "`★ Insight ─────────────────────────────────────`\nThis is an insight.\n`─────────────────────────────────────────────────`",
      },
    ]);

    const results = parseInsightsFromJsonl(jsonl, "session1", "proj", "C:\\dev\\proj");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("This is an insight.");
    expect(results[0].sessionId).toBe("session1");
    expect(results[0].project).toBe("proj");
  });

  it("extracts insight from 💡 marker", () => {
    const jsonl = makeJsonl([
      {
        type: "assistant",
        text: "💡\nAnother insight here.\n\n",
      },
    ]);

    const results = parseInsightsFromJsonl(jsonl, "s2", "proj", "C:\\dev\\proj");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Another insight here.");
  });

  it("extracts insight from **Insight** marker", () => {
    const jsonl = makeJsonl([
      {
        type: "assistant",
        text: "**Insight**\nBold insight content.\n\n",
      },
    ]);

    const results = parseInsightsFromJsonl(jsonl, "s3", "proj", "C:\\dev\\proj");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Bold insight content.");
  });

  it("ignores user messages", () => {
    const jsonl = makeJsonl([
      {
        type: "user",
        text: "`★ Insight ─────────────────────────────────────`\nNot an insight.\n`─────────────────────────────────────────────────`",
      },
    ]);

    const results = parseInsightsFromJsonl(jsonl, "s4", "proj", "C:\\dev\\proj");
    expect(results).toHaveLength(0);
  });

  it("handles multiple insights in one message", () => {
    const jsonl = makeJsonl([
      {
        type: "assistant",
        text: "`★ Insight ─────────────────────────────────────`\nFirst insight.\n`─────────────────────────────────────────────────`\n\nSome other text.\n\n`★ Insight ─────────────────────────────────────`\nSecond insight.\n`─────────────────────────────────────────────────`",
      },
    ]);

    const results = parseInsightsFromJsonl(jsonl, "s5", "proj", "C:\\dev\\proj");
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("First insight.");
    expect(results[1].content).toBe("Second insight.");
  });

  it("skips malformed JSON lines", () => {
    const jsonl = "not json\n" + makeJsonl([
      { type: "assistant", text: "💡\nValid insight.\n\n" },
    ]);

    const results = parseInsightsFromJsonl(jsonl, "s6", "proj", "C:\\dev\\proj");
    expect(results).toHaveLength(1);
  });

  it("skips empty lines", () => {
    const jsonl = "\n\n" + makeJsonl([
      { type: "assistant", text: "💡\nInsight.\n\n" },
    ]) + "\n\n";

    const results = parseInsightsFromJsonl(jsonl, "s7", "proj", "C:\\dev\\proj");
    expect(results).toHaveLength(1);
  });
});

describe("parseInsightsMd", () => {
  it("returns empty for empty string", () => {
    const { info, knownIds } = parseInsightsMd("");
    expect(info.entries).toHaveLength(0);
    expect(info.total).toBe(0);
    expect(knownIds.size).toBe(0);
  });

  it("parses a single insight entry", () => {
    const md = `# Insights

<!-- insight:abc123def456 | session:sess1 | 2026-04-10T12:00:00.000Z -->
## ★ Insight
This is the insight content.

---
`;
    const { info, knownIds } = parseInsightsMd(md);
    expect(info.entries).toHaveLength(1);
    expect(info.total).toBe(1);
    expect(knownIds.has("abc123def456")).toBe(true);

    const entry = info.entries[0];
    expect(entry.id).toBe("abc123def456");
    expect(entry.sessionId).toBe("sess1");
    expect(entry.content).toBe("This is the insight content.");
  });

  it("parses multiple entries", () => {
    const md = `# Insights

<!-- insight:aaa111 | session:s1 | 2026-04-10T14:00:00.000Z -->
## ★ Insight
First insight.

---

<!-- insight:bbb222 | session:s2 | 2026-04-10T12:00:00.000Z -->
## ★ Insight
Second insight.

---
`;
    const { info, knownIds } = parseInsightsMd(md);
    expect(info.entries).toHaveLength(2);
    expect(knownIds.size).toBe(2);
    expect(info.entries[0].content).toBe("First insight.");
    expect(info.entries[1].content).toBe("Second insight.");
  });

  it("handles multi-line insight content", () => {
    const md = `<!-- insight:ccc333 | session:s1 | 2026-04-10T12:00:00.000Z -->
## ★ Insight
Line one.
Line two.
Line three.

---
`;
    const { info } = parseInsightsMd(md);
    expect(info.entries[0].content).toBe("Line one.\nLine two.\nLine three.");
  });
});
