import { describe, expect, it } from "vitest";
import {
  extractTicketsFromText,
  extractTicketsFromEntries,
} from "@/lib/usage/ticketExtractor";
import type { ConversationEntry } from "@/lib/scanner/claudeConversations";

// ── fixture builders ────────────────────────────────────────────────────────

function userText(text: string): ConversationEntry {
  // User content is a bare string on plain prompts (the type models the
  // array shape; the string shape is the documented mixed case). Cast
  // through unknown to stage that runtime shape in the fixture.
  return {
    type: "user",
    timestamp: "2026-05-29T12:00:00Z",
    message: { role: "user", content: text },
  } as unknown as ConversationEntry;
}

function userTextBlocks(...texts: string[]): ConversationEntry {
  return {
    type: "user",
    timestamp: "2026-05-29T12:00:00Z",
    message: {
      role: "user",
      content: texts.map((t) => ({ type: "text", text: t })),
    },
  } as ConversationEntry;
}

function userToolResult(toolUseId: string, content: unknown): ConversationEntry {
  return {
    type: "user",
    timestamp: "2026-05-29T12:00:01Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  } as ConversationEntry;
}

function assistantText(text: string): ConversationEntry {
  return {
    type: "assistant",
    timestamp: "2026-05-29T12:00:02Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as ConversationEntry;
}

// ── extractTicketsFromText ──────────────────────────────────────────────────

describe("extractTicketsFromText", () => {
  it("parses a Linear issue URL", () => {
    expect(
      extractTicketsFromText("see https://linear.app/acme/issue/ENG-123"),
    ).toEqual([
      { provider: "linear", key: "ENG-123", url: "https://linear.app/acme/issue/ENG-123" },
    ]);
  });

  it("strips the title slug off a Linear URL (canonical link)", () => {
    const [t] = extractTicketsFromText(
      "https://linear.app/acme/issue/ENG-123/fix-the-thing",
    );
    expect(t.url).toBe("https://linear.app/acme/issue/ENG-123");
    expect(t.key).toBe("ENG-123");
  });

  it("parses a Jira browse URL on a cloud host", () => {
    expect(
      extractTicketsFromText("blocked by https://acme.atlassian.net/browse/PROJ-45"),
    ).toEqual([
      { provider: "jira", key: "PROJ-45", url: "https://acme.atlassian.net/browse/PROJ-45" },
    ]);
  });

  it("parses a self-hosted Jira host (must contain a dot)", () => {
    const [t] = extractTicketsFromText("https://jira.example.com/browse/AB-9");
    expect(t).toEqual({
      provider: "jira",
      key: "AB-9",
      url: "https://jira.example.com/browse/AB-9",
    });
  });

  it("ignores a /browse/ path on a single-label host (not a real Jira host)", () => {
    expect(extractTicketsFromText("https://localhost/browse/AB-1")).toEqual([]);
  });

  it("parses a GitHub issue URL into owner/repo#N", () => {
    expect(
      extractTicketsFromText("fixes https://github.com/foo/bar/issues/42"),
    ).toEqual([
      { provider: "github", key: "foo/bar#42", url: "https://github.com/foo/bar/issues/42" },
    ]);
  });

  it("strips trailing slash / anchor / query off a GitHub issue URL", () => {
    expect(extractTicketsFromText("https://github.com/foo/bar/issues/42/")[0].url).toBe(
      "https://github.com/foo/bar/issues/42",
    );
    expect(
      extractTicketsFromText("https://github.com/foo/bar/issues/42#issuecomment-7")[0].url,
    ).toBe("https://github.com/foo/bar/issues/42");
  });

  it("does NOT match a GitHub PR URL (only /issues/)", () => {
    expect(extractTicketsFromText("https://github.com/foo/bar/pull/42")).toEqual([]);
  });

  it("rejects issue number 0 and a number glued to letters", () => {
    expect(extractTicketsFromText("https://github.com/foo/bar/issues/0")).toEqual([]);
    expect(extractTicketsFromText("https://github.com/foo/bar/issues/42x")).toEqual([]);
  });

  it("does NOT match a bare issue key (deferred scope — full URLs only)", () => {
    expect(extractTicketsFromText("please look at ENG-123 and PROJ-45")).toEqual([]);
  });

  it("does NOT match a bare #number reference", () => {
    expect(extractTicketsFromText("this closes #123 in the code")).toEqual([]);
  });

  it("dedupes repeated URLs and sorts by (provider, key, url)", () => {
    const out = extractTicketsFromText(
      [
        "https://linear.app/acme/issue/ENG-9",
        "https://github.com/foo/bar/issues/7",
        "https://acme.atlassian.net/browse/PROJ-2",
        "https://github.com/foo/bar/issues/7", // dup
      ].join("\n"),
    );
    // github < jira < linear (alphabetical provider order)
    expect(out.map((t) => t.provider)).toEqual(["github", "jira", "linear"]);
    expect(out).toHaveLength(3);
  });

  it("returns [] when there is no tracker URL", () => {
    expect(extractTicketsFromText("just some prose, no links")).toEqual([]);
  });
});

// ── extractTicketsFromEntries ───────────────────────────────────────────────

describe("extractTicketsFromEntries", () => {
  it("returns [] for no entries", () => {
    expect(extractTicketsFromEntries([])).toEqual([]);
  });

  it("finds a URL in a plain (string-content) user prompt", () => {
    const out = extractTicketsFromEntries([
      userText("implement https://linear.app/acme/issue/ENG-1 today"),
    ]);
    expect(out).toEqual([
      { provider: "linear", key: "ENG-1", url: "https://linear.app/acme/issue/ENG-1" },
    ]);
  });

  it("finds a URL in array-shaped user text blocks", () => {
    const out = extractTicketsFromEntries([
      userTextBlocks("first part", "ref https://github.com/foo/bar/issues/3"),
    ]);
    expect(out[0].key).toBe("foo/bar#3");
  });

  it("finds a URL in assistant text", () => {
    const out = extractTicketsFromEntries([
      assistantText("I filed https://acme.atlassian.net/browse/OPS-12 for this."),
    ]);
    expect(out[0]).toEqual({
      provider: "jira",
      key: "OPS-12",
      url: "https://acme.atlassian.net/browse/OPS-12",
    });
  });

  it("finds a URL in a gh-issue-create tool_result (string content)", () => {
    const out = extractTicketsFromEntries([
      userToolResult("t1", "https://github.com/foo/bar/issues/88\n"),
    ]);
    expect(out[0].key).toBe("foo/bar#88");
  });

  it("finds a URL in a tool_result with array content blocks", () => {
    const out = extractTicketsFromEntries([
      userToolResult("t2", [
        { type: "text", text: "Created issue:" },
        { type: "text", text: "https://github.com/foo/bar/issues/99" },
      ]),
    ]);
    expect(out[0].key).toBe("foo/bar#99");
  });

  it("falls back to top-level content when message.content is an empty array", () => {
    // Copilot/Codex review: Claude sometimes writes `message.content` as
    // an empty array with the real blocks (incl. tool_results) on the
    // top-level `content` field. A nullish-only fallback would skip them
    // and silently drop the ticket URL; the length-based fallback must
    // scan top-level content. Mirrors parser.ts:236-241.
    const entry = {
      type: "user",
      timestamp: "2026-05-29T12:00:03Z",
      message: { role: "user", content: [] },
      content: [
        { type: "tool_result", tool_use_id: "t9", content: "https://github.com/foo/bar/issues/321" },
      ],
    } as unknown as ConversationEntry;
    const out = extractTicketsFromEntries([entry]);
    expect(out).toEqual([
      { provider: "github", key: "foo/bar#321", url: "https://github.com/foo/bar/issues/321" },
    ]);
  });

  it("dedupes the same URL seen across a prompt and a tool result", () => {
    const out = extractTicketsFromEntries([
      userText("work on https://linear.app/acme/issue/ENG-5"),
      assistantText("done, see https://linear.app/acme/issue/ENG-5"),
    ]);
    expect(out).toHaveLength(1);
  });
});
