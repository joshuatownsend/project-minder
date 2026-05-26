import { describe, expect, it } from "vitest";
import {
  extractPrLinkFromText,
  extractPrsFromEntries,
} from "@/lib/usage/prExtractor";
import type { ConversationEntry } from "@/lib/scanner/claudeConversations";

// Helper builders for terse fixtures.
function assistantBashCall(toolUseId: string, command: string): ConversationEntry {
  return {
    type: "assistant",
    timestamp: "2026-05-26T12:00:00Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command } }],
    },
  } as ConversationEntry;
}

function userToolResult(
  toolUseId: string,
  content: unknown,
): ConversationEntry {
  return {
    type: "user",
    timestamp: "2026-05-26T12:00:01Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  } as ConversationEntry;
}

describe("extractPrLinkFromText", () => {
  it("parses a bare PR URL", () => {
    const link = extractPrLinkFromText(
      "https://github.com/anthropics/claude-code/pull/123",
    );
    expect(link).toEqual({
      url: "https://github.com/anthropics/claude-code/pull/123",
      number: 123,
      repo: "anthropics/claude-code",
    });
  });

  it("parses a URL embedded in surrounding text", () => {
    const link = extractPrLinkFromText(
      "Created pull request: https://github.com/foo/bar/pull/42 ✓",
    );
    expect(link?.number).toBe(42);
    expect(link?.repo).toBe("foo/bar");
  });

  it("strips trailing slash and anchor", () => {
    const a = extractPrLinkFromText("https://github.com/foo/bar/pull/42/");
    expect(a?.url).toBe("https://github.com/foo/bar/pull/42");
    const b = extractPrLinkFromText(
      "https://github.com/foo/bar/pull/42#issuecomment-99",
    );
    expect(b?.url).toBe("https://github.com/foo/bar/pull/42");
  });

  it("strips query string", () => {
    const link = extractPrLinkFromText(
      "https://github.com/foo/bar/pull/42?notification_referrer_id=xyz",
    );
    expect(link?.url).toBe("https://github.com/foo/bar/pull/42");
  });

  it("handles repos with dots and hyphens", () => {
    expect(
      extractPrLinkFromText("https://github.com/scikit-learn/scikit-learn/pull/1")?.repo,
    ).toBe("scikit-learn/scikit-learn");
    expect(
      extractPrLinkFromText("https://github.com/foo/next.js/pull/2")?.repo,
    ).toBe("foo/next.js");
  });

  it("accepts http (not just https)", () => {
    expect(extractPrLinkFromText("http://github.com/foo/bar/pull/3")?.number).toBe(3);
  });

  it("returns null when no PR URL is present", () => {
    expect(extractPrLinkFromText("nothing here")).toBeNull();
    // `/issues/` and `/discussions/` share the prefix but are not PRs.
    expect(extractPrLinkFromText("https://github.com/foo/bar/issues/1")).toBeNull();
    expect(
      extractPrLinkFromText("https://github.com/foo/bar/discussions/1"),
    ).toBeNull();
  });

  it("returns null on a non-positive PR number", () => {
    // The regex requires \d+ so "/pull/0" would parse to 0 — we reject as
    // a corruption guard (GitHub PR numbers start at 1).
    expect(extractPrLinkFromText("https://github.com/foo/bar/pull/0")).toBeNull();
  });

  it("rejects URLs whose PR number is glued to non-digit text", () => {
    // Code review #10: `pull/42xyz` previously extracted `42` because the
    // regex had no trailing boundary after \d+. Now we require a non-digit
    // boundary so partial-token matches don't synthesize phantom PRs.
    expect(extractPrLinkFromText("https://github.com/foo/bar/pull/42xyz")).toBeNull();
  });

  it("rejects owner/repo segments that contain no alphanumerics", () => {
    // Code review #14: a malformed URL like https://github.com/./../pull/5
    // matched the raw character class but produced a path-traversal-ish
    // repo string the UI would render verbatim.
    expect(extractPrLinkFromText("https://github.com/./../pull/5")).toBeNull();
    expect(extractPrLinkFromText("https://github.com/foo/../pull/5")).toBeNull();
    expect(extractPrLinkFromText("https://github.com/../bar/pull/5")).toBeNull();
  });

  it("prefers a URL that appears on its own line over an embedded reference", () => {
    // Code review #3: `gh pr create`'s canonical output puts the new PR URL
    // on its own line at the start. When the result body echoes a referenced
    // PR earlier in the text (e.g., from a `--body 'Closes #5'` echo), the
    // embedded URL would otherwise win.
    const text =
      "Creating from --body containing Closes https://github.com/foo/bar/pull/5\n" +
      "https://github.com/foo/bar/pull/200\n";
    const link = extractPrLinkFromText(text);
    // The new URL (#200) is on its own line; the referenced #5 is embedded.
    expect(link?.number).toBe(200);
  });

  it("falls back to the first URL when none is line-isolated", () => {
    // Defensive: when no URL appears at a line start (rare), don't return null
    // — fall back to the first match so we don't silently drop legitimate PRs
    // captured in non-canonical output formats.
    const text = "  https://github.com/foo/bar/pull/42  ";
    const link = extractPrLinkFromText(text);
    expect(link?.number).toBe(42);
  });
});

describe("extractPrsFromEntries", () => {
  it("returns [] on empty input", () => {
    expect(extractPrsFromEntries([])).toEqual([]);
  });

  it("matches a `gh pr create` Bash call to its tool_result by tool_use_id", () => {
    const entries: ConversationEntry[] = [
      assistantBashCall(
        "toolu_01",
        "gh pr create --title 'feat: thing' --body '...'",
      ),
      userToolResult("toolu_01", "https://github.com/foo/bar/pull/7"),
    ];
    const prs = extractPrsFromEntries(entries);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toEqual({
      url: "https://github.com/foo/bar/pull/7",
      number: 7,
      repo: "foo/bar",
    });
  });

  it("matches by tool_use_id even when results arrive out of order (interleaved tool calls)", () => {
    // Two Bash calls dispatched in parallel; the non-PR call's result
    // arrives between the PR call and its result. Positional matching
    // would associate the wrong result with the PR call. tool_use_id
    // matching MUST recover the right pairing.
    const entries: ConversationEntry[] = [
      // Both calls in the same assistant turn (parallel dispatch).
      {
        type: "assistant",
        timestamp: "2026-05-26T12:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_pr", name: "Bash", input: { command: "gh pr create --fill" } },
            { type: "tool_use", id: "toolu_ls", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      } as ConversationEntry,
      // Results in REVERSE order — ls completes first, gh pr create second.
      userToolResult("toolu_ls", "total 24\ndrwxr-xr-x ..."),
      userToolResult("toolu_pr", "https://github.com/foo/bar/pull/12"),
    ];
    const prs = extractPrsFromEntries(entries);
    expect(prs).toEqual([
      { url: "https://github.com/foo/bar/pull/12", number: 12, repo: "foo/bar" },
    ]);
  });

  it("handles tool_result content as a string (not just an array of blocks)", () => {
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_01", "gh pr create --fill"),
      userToolResult("toolu_01", "https://github.com/foo/bar/pull/9"),
    ];
    const prs = extractPrsFromEntries(entries);
    expect(prs[0]?.number).toBe(9);
  });

  it("handles tool_result content as an array of text blocks", () => {
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_01", "gh pr create --fill"),
      userToolResult("toolu_01", [
        { type: "text", text: "Creating pull request...\n" },
        { type: "text", text: "https://github.com/foo/bar/pull/8\n" },
      ]),
    ];
    const prs = extractPrsFromEntries(entries);
    expect(prs[0]?.number).toBe(8);
  });

  it("returns multiple PRs when a session creates multiple", () => {
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_a", "gh pr create --title 'a'"),
      userToolResult("toolu_a", "https://github.com/foo/bar/pull/1"),
      assistantBashCall("toolu_b", "gh pr create --title 'b'"),
      userToolResult("toolu_b", "https://github.com/foo/bar/pull/2"),
    ];
    const prs = extractPrsFromEntries(entries);
    expect(prs.map((p) => p.number)).toEqual([1, 2]);
  });

  it("dedupes a PR URL that appears under multiple tool_use_ids", () => {
    // E.g. user re-ran the command; both invocations report the same PR.
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_a", "gh pr create --fill"),
      userToolResult("toolu_a", "https://github.com/foo/bar/pull/5"),
      assistantBashCall("toolu_b", "gh pr create --fill"),
      userToolResult("toolu_b", "https://github.com/foo/bar/pull/5"),
    ];
    expect(extractPrsFromEntries(entries)).toEqual([
      { url: "https://github.com/foo/bar/pull/5", number: 5, repo: "foo/bar" },
    ]);
  });

  it("ignores `gh issue create` even when the result text contains a PR URL", () => {
    // Defensive: a discussion that includes a PR URL inside an issue body
    // should not be misattributed as a PR creation.
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_01", "gh issue create --title 'bug'"),
      userToolResult(
        "toolu_01",
        "Issue created. See related: https://github.com/foo/bar/pull/99",
      ),
    ];
    expect(extractPrsFromEntries(entries)).toEqual([]);
  });

  it("ignores `gh pr create` mentioned inside a quoted string in another command", () => {
    // Code review #4: `grep "gh pr create" docs/` or
    // `echo "remember gh pr create"` previously matched because the regex
    // was a literal substring scan. Quoted regions are now stripped before
    // the boundary check.
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_01", `grep -rn "gh pr create" docs/`),
      userToolResult(
        "toolu_01",
        "docs/help/sessions.md:42: When you run gh pr create the URL is captured\n" +
          "docs/integrations/github.md:7: See https://github.com/foo/bar/pull/123",
      ),
    ];
    expect(extractPrsFromEntries(entries)).toEqual([]);
  });

  it("ignores `gh pr create` inside a single-quoted echo argument", () => {
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_01", `echo 'remember to gh pr create later'`),
      userToolResult("toolu_01", "https://github.com/foo/bar/pull/42"),
    ];
    expect(extractPrsFromEntries(entries)).toEqual([]);
  });

  it("matches `gh pr create` chained after &&", () => {
    // Defense in depth: the new statement-boundary regex must still accept
    // the legitimate chained-invocation form Claude routinely produces.
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_01", "git push -u origin branch && gh pr create --fill"),
      userToolResult("toolu_01", "https://github.com/foo/bar/pull/42"),
    ];
    const prs = extractPrsFromEntries(entries);
    expect(prs).toHaveLength(1);
    expect(prs[0]?.number).toBe(42);
  });

  it("ignores PR URLs that appear in tool_results for non-`gh pr create` Bash calls", () => {
    // A `git log` output that happens to contain a PR URL must not be
    // promoted to a "this session created that PR" claim.
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_01", "git log --oneline -n 5"),
      userToolResult(
        "toolu_01",
        "abc123 (#42) feat: thing — https://github.com/foo/bar/pull/42",
      ),
    ];
    expect(extractPrsFromEntries(entries)).toEqual([]);
  });

  it("ignores Bash calls with no matching tool_result", () => {
    // Session crashed mid-PR-create before the result arrived — we shouldn't
    // synthesize anything from thin air.
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_01", "gh pr create --fill"),
    ];
    expect(extractPrsFromEntries(entries)).toEqual([]);
  });

  it("ignores Bash calls whose result text contains no PR URL", () => {
    // `gh pr create` failed with `--web` flag or hit an auth error; result
    // text is empty/garbage. Don't infer a PR.
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_01", "gh pr create --fill"),
      userToolResult("toolu_01", "error: not logged in"),
    ];
    expect(extractPrsFromEntries(entries)).toEqual([]);
  });

  it("ignores tool_result blocks missing a tool_use_id", () => {
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_01", "gh pr create --fill"),
      // Hand-crafted: no tool_use_id — should be a no-op, not a crash.
      {
        type: "user",
        timestamp: "2026-05-26T12:00:01Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", content: "https://github.com/foo/bar/pull/1" },
          ],
        },
      } as ConversationEntry,
    ];
    expect(extractPrsFromEntries(entries)).toEqual([]);
  });

  it("tolerates multiline `gh pr create` commands (HEREDOC-style)", () => {
    const command = `gh pr create --title "the title" --body "$(cat <<'EOF'
multi
line
body
EOF
)"`;
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_01", command),
      userToolResult("toolu_01", "https://github.com/foo/bar/pull/77"),
    ];
    expect(extractPrsFromEntries(entries)[0]?.number).toBe(77);
  });

  it("does not match `gh-pr-create` or similar near-misses", () => {
    // The \b word-boundary regex should reject hyphenated aliases.
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_01", "gh-pr-create --fill"),
      userToolResult("toolu_01", "https://github.com/foo/bar/pull/1"),
    ];
    expect(extractPrsFromEntries(entries)).toEqual([]);
  });

  it("returns content from concatenated tool_result blocks under the same tool_use_id", () => {
    // Rare but legal: two tool_result blocks under one user turn share a
    // tool_use_id (e.g. streamed output). We concatenate before matching.
    const entries: ConversationEntry[] = [
      assistantBashCall("toolu_01", "gh pr create --fill"),
      {
        type: "user",
        timestamp: "2026-05-26T12:00:01Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_01", content: "Creating..." },
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: "https://github.com/foo/bar/pull/55",
            },
          ],
        },
      } as ConversationEntry,
    ];
    expect(extractPrsFromEntries(entries)[0]?.number).toBe(55);
  });
});
