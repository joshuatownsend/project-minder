import { describe, it, expect } from "vitest";
import {
  fenceFor,
  formatDuration,
  isExportDetail,
  renderSessionMarkdown,
  resolveExportOptions,
  summarizeToolInput,
  type ExportMessage,
  type ExportMeta,
} from "@/lib/sessions/markdownExport";

const META: ExportMeta = {
  sessionId: "abc-123",
  projectName: "project-minder",
  projectPath: "C:\\dev\\project-minder",
  projectSlug: "project-minder",
  title: "Fix the flaky test",
  gitBranch: "main",
  startTime: "2026-07-30T10:00:00.000Z",
  endTime: "2026-07-30T11:12:00.000Z",
  durationMs: 72 * 60_000,
  costEstimate: 3.4219,
  modelsUsed: ["claude-opus-5"],
  messageCount: 4,
  fidelity: "full",
};

const EXPORTED_AT = "2026-08-01T00:00:00.000Z";

function render(messages: ExportMessage[], options = {}, meta: ExportMeta = META) {
  return renderSessionMarkdown(meta, messages, { exportedAt: EXPORTED_AT, ...options });
}

function user(text: string): ExportMessage {
  return { role: "user", timestamp: "2026-07-30T10:00:04.000Z", blocks: [{ kind: "text", text }] };
}

// ─── Fencing ─────────────────────────────────────────────────────────────────

describe("fenceFor", () => {
  it("uses three backticks when the content has none", () => {
    expect(fenceFor("plain text")).toBe("```");
  });

  it("outgrows the longest backtick run in the content", () => {
    expect(fenceFor("a ``` b")).toBe("````");
    expect(fenceFor("a ````` b")).toBe("``````");
  });

  it("is unaffected by many short runs", () => {
    // Length, not count — ten inline spans still only need a 3-tick fence.
    expect(fenceFor("`a` `b` `c` `d` `e` `f` `g` `h` `i` `j`")).toBe("```");
  });
});

describe("fence safety end to end", () => {
  it("wraps a tool result containing a fence without terminating early", () => {
    // The failure this prevents: a 3-backtick fence closes at the
    // transcript's own fence and every later line renders as prose.
    const messages: ExportMessage[] = [
      {
        role: "user",
        blocks: [
          {
            kind: "tool_result",
            toolName: "Bash",
            text: "output:\n```js\nconst x = 1;\n```\ndone",
          },
        ],
      },
    ];
    const { markdown } = render(messages, { detail: "full" });
    expect(markdown).toContain("````\noutput:");
    expect(markdown).toContain("```js");
    // Every fence run in the body must pair up.
    const fences = markdown.match(/^`{3,}/gm) ?? [];
    expect(fences.length % 2).toBe(0);
  });

  it("keeps a trailing backtick from merging into the closing fence", () => {
    const messages: ExportMessage[] = [
      { role: "user", blocks: [{ kind: "tool_result", text: "ends with a tick `" }] },
    ];
    const { markdown } = render(messages, { detail: "full" });
    expect(markdown).toContain("ends with a tick `\n```");
  });
});

// ─── Front matter ────────────────────────────────────────────────────────────

describe("front matter", () => {
  it("quotes every scalar so Windows paths and colons survive", () => {
    const { markdown } = render([user("hi")]);
    expect(markdown).toContain('project_path: "C:\\\\dev\\\\project-minder"');
    expect(markdown).toContain('session: "abc-123"');
    expect(markdown).toContain('models: ["claude-opus-5"]');
  });

  it("omits absent fields rather than emitting empty keys", () => {
    const { markdown } = render([user("hi")], {}, { sessionId: "s1", fidelity: "full" });
    expect(markdown).not.toContain("branch:");
    expect(markdown).not.toContain("project:");
    expect(markdown).not.toContain("models:");
  });

  it("rounds cost and records the detail level and fidelity", () => {
    const { markdown } = render([user("hi")], { detail: "minimal" });
    expect(markdown).toContain("cost_usd: 3.4219");
    expect(markdown).toContain('detail: "minimal"');
    expect(markdown).toContain('fidelity: "full"');
    expect(markdown).toContain(`exported: "${EXPORTED_AT}"`);
  });

  it("survives a project name containing YAML metacharacters", () => {
    const { markdown } = render([user("hi")], {}, { ...META, projectName: 'a: b #c "d"' });
    expect(markdown).toContain('project: "a: b #c \\"d\\""');
  });

  it("is byte-identical across two renders of the same input", () => {
    // No wall-clock reads inside the renderer — `exportedAt` is injected.
    expect(render([user("hi")]).markdown).toBe(render([user("hi")]).markdown);
  });
});

// ─── Detail levels ───────────────────────────────────────────────────────────

const RICH: ExportMessage[] = [
  user("please run the tests"),
  {
    role: "assistant",
    timestamp: "2026-07-30T10:00:12.000Z",
    model: "claude-opus-5",
    blocks: [
      { kind: "thinking", text: "I should run the test suite first." },
      { kind: "text", text: "Running the suite now." },
      { kind: "tool_use", toolName: "Bash", toolUseId: "t1", input: { command: "pnpm test" } },
    ],
  },
  {
    role: "user",
    blocks: [{ kind: "tool_result", toolName: "Bash", toolUseId: "t1", text: "4151 passed" }],
  },
];

describe("detail levels", () => {
  it("minimal keeps prose and drops tool calls and results", () => {
    const { markdown, stats } = render(RICH, { detail: "minimal" });
    expect(markdown).toContain("please run the tests");
    expect(markdown).toContain("Running the suite now.");
    expect(markdown).not.toContain("pnpm test");
    expect(markdown).not.toContain("4151 passed");
    expect(stats.blocksOmitted).toBe(3); // thinking + tool_use + tool_result
  });

  it("standard adds tool calls and results but still hides thinking", () => {
    const { markdown } = render(RICH, { detail: "standard" });
    expect(markdown).toContain("pnpm test");
    expect(markdown).toContain("4151 passed");
    expect(markdown).not.toContain("I should run the test suite first.");
  });

  it("full includes thinking, collapsed with its size", () => {
    const { markdown } = render(RICH, { detail: "full" });
    expect(markdown).toContain("<summary>Thinking (34 chars)</summary>");
    expect(markdown).toContain("I should run the test suite first.");
  });

  it("an explicit toggle overrides the preset in both directions", () => {
    expect(render(RICH, { detail: "standard", thinking: true }).markdown).toContain(
      "I should run the test suite first.",
    );
    expect(render(RICH, { detail: "full", thinking: false }).markdown).not.toContain(
      "I should run the test suite first.",
    );
  });

  it("defaults to standard for an absent or bogus level", () => {
    expect(resolveExportOptions().detail).toBe("standard");
    expect(resolveExportOptions({ detail: "enormous" as never }).detail).toBe("standard");
  });
});

describe("resolveExportOptions caps", () => {
  it("clamps a negative cap to zero and a huge one to the ceiling", () => {
    expect(resolveExportOptions({ maxToolChars: -5 }).maxToolChars).toBe(0);
    expect(resolveExportOptions({ maxTextChars: 1e12 }).maxTextChars).toBe(5_000_000);
  });

  it("treats null as uncapped and a non-finite number as 'use the preset'", () => {
    expect(resolveExportOptions({ maxTextChars: null }).maxTextChars).toBeNull();
    expect(resolveExportOptions({ detail: "standard", maxTextChars: Number.NaN }).maxTextChars).toBe(12_000);
  });
});

// ─── Truncation ──────────────────────────────────────────────────────────────

describe("truncation is always announced", () => {
  it("marks a cut block inline and counts the loss", () => {
    const long = "x".repeat(5_000);
    const { markdown, stats } = render([{ role: "user", blocks: [{ kind: "text", text: long }] }], {
      detail: "minimal",
    });
    expect(markdown).toContain("… truncated 1,000 characters");
    expect(stats.blocksTruncated).toBe(1);
    expect(stats.charsTruncated).toBe(1_000);
  });

  it("summarizes omissions and truncations in a footer note", () => {
    const long = "y".repeat(9_000);
    const { markdown } = render(
      [
        { role: "user", blocks: [{ kind: "text", text: long }] },
        { role: "assistant", blocks: [{ kind: "thinking", text: "hidden" }] },
      ],
      { detail: "minimal" },
    );
    expect(markdown).toContain("_Export notes:");
    expect(markdown).toContain("1 block truncated (5,000 characters)");
    expect(markdown).toContain("omitted by the `minimal` detail level");
  });

  it("writes no footer when nothing was left out", () => {
    expect(render([user("short")], { detail: "full" }).markdown).not.toContain("_Export notes:");
  });

  it("does not truncate prose under `full`, which is uncapped", () => {
    const long = "z".repeat(200_000);
    const { markdown, stats } = render([{ role: "user", blocks: [{ kind: "text", text: long }] }], {
      detail: "full",
    });
    expect(stats.charsTruncated).toBe(0);
    expect(markdown).toContain(long);
  });
});

// ─── Structure ───────────────────────────────────────────────────────────────

describe("document structure", () => {
  it("drops the heading of a message whose every block was filtered out", () => {
    // An assistant turn that only made tool calls leaves nothing to show
    // under `minimal`; a bare "## Assistant" would read as a lost reply.
    const messages: ExportMessage[] = [
      user("go"),
      { role: "assistant", blocks: [{ kind: "tool_use", toolName: "Read", input: { file_path: "a.ts" } }] },
    ];
    const { markdown } = render(messages, { detail: "minimal" });
    expect(markdown).not.toContain("## Assistant");
    expect(markdown).toContain("## User");
  });

  it("labels the assistant heading with its clock time and model", () => {
    const { markdown } = render(RICH, { detail: "standard" });
    expect(markdown).toContain("## Assistant · 10:00:12 · claude-opus-5");
  });

  it("excludes subagent messages by default and counts them", () => {
    const messages: ExportMessage[] = [
      user("go"),
      { role: "assistant", isSidechain: true, blocks: [{ kind: "text", text: "subagent reply" }] },
    ];
    const plain = render(messages, { detail: "standard" });
    expect(plain.markdown).not.toContain("subagent reply");
    expect(plain.stats.sidechainsSkipped).toBe(1);
    expect(plain.markdown).toContain("1 subagent message excluded");

    const withThem = render(messages, { detail: "full" });
    expect(withThem.markdown).toContain("subagent reply");
    expect(withThem.markdown).toContain("(subagent)");
  });

  it("renders an API error as a caution callout", () => {
    const { markdown } = render([
      { role: "assistant", blocks: [{ kind: "error", text: "529 overloaded" }] },
    ]);
    expect(markdown).toContain("> [!CAUTION]");
    expect(markdown).toContain("529 overloaded");
  });

  it("warns loudly when the body came from the index", () => {
    const { markdown } = render([user("hi")], {}, { ...META, fidelity: "index" });
    expect(markdown).toContain("> [!WARNING]");
    expect(markdown).toContain("Reduced fidelity");
    expect(markdown).toContain('fidelity: "index"');
  });

  it("never stacks its own blank separator lines", () => {
    const { markdown } = render(RICH, { detail: "full" });
    expect(markdown).not.toMatch(/\n{3}/);
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("preserves blank lines inside content — separators collapse, transcripts do not", () => {
    // Tidying the finished document with a `\n{3,}` collapse would also
    // rewrite the transcript, which is the exact infidelity this exporter
    // exists to avoid. Blank lines de-duplicate at emit time instead.
    const spaced = "first\n\n\n\nlast";
    const { markdown } = render(
      [{ role: "user", blocks: [{ kind: "tool_result", toolName: "Bash", text: spaced }] }],
      { detail: "full" },
    );
    expect(markdown).toContain(spaced);
  });

  it("counts bytes, not characters, so the reported size is the file size", () => {
    const { markdown, stats } = render([user("héllo — ✓")]);
    expect(stats.bytes).toBe(Buffer.byteLength(markdown, "utf8"));
    expect(stats.bytes).toBeGreaterThan(markdown.length);
  });
});

// ─── Tool rendering ──────────────────────────────────────────────────────────

describe("tool calls", () => {
  it("leads with a one-line gist drawn from the intent-carrying argument", () => {
    expect(summarizeToolInput({ file_path: "src/a.ts" })).toBe("src/a.ts");
    expect(summarizeToolInput({ command: "pnpm test" })).toBe("pnpm test");
    expect(summarizeToolInput({ unknown_key: "x" })).toBe("");
    expect(summarizeToolInput(undefined)).toBe("");
  });

  it("skips the JSON block when the gist already says everything", () => {
    // A single-string-argument call would otherwise be printed twice.
    const { markdown } = render(
      [{ role: "assistant", blocks: [{ kind: "tool_use", toolName: "Bash", input: { command: "ls" } }] }],
      { detail: "standard" },
    );
    expect(markdown).toContain("**`Bash`** — ls");
    expect(markdown).not.toContain('"command": "ls"');
  });

  it("prints the JSON block when there is more than the gist", () => {
    const { markdown } = render(
      [
        {
          role: "assistant",
          blocks: [{ kind: "tool_use", toolName: "Edit", input: { file_path: "a.ts", old_string: "x" } }],
        },
      ],
      { detail: "standard" },
    );
    expect(markdown).toContain('"old_string": "x"');
  });

  it("survives unserializable tool arguments instead of throwing", () => {
    const circular: Record<string, unknown> = { file_path: "a.ts" };
    circular.self = circular;
    const { markdown } = render(
      [{ role: "assistant", blocks: [{ kind: "tool_use", toolName: "Edit", input: circular }] }],
      { detail: "standard" },
    );
    expect(markdown).toContain("[unserializable tool input]");
  });

  it("collapses a tool result and labels an errored one", () => {
    const { markdown } = render(
      [
        {
          role: "user",
          blocks: [{ kind: "tool_result", toolName: "Bash", text: "boom", isError: true }],
        },
      ],
      { detail: "standard" },
    );
    expect(markdown).toContain("<summary>Result (error) — `Bash` (4 chars)</summary>");
  });
});

// ─── Small helpers ───────────────────────────────────────────────────────────

describe("helpers", () => {
  it("formats durations in hours and minutes", () => {
    expect(formatDuration(72 * 60_000)).toBe("1h 12m");
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(10_000)).toBe("<1m");
    expect(formatDuration(undefined)).toBeUndefined();
    expect(formatDuration(-1)).toBeUndefined();
  });

  it("recognizes only the three shipped detail levels", () => {
    expect(isExportDetail("full")).toBe(true);
    expect(isExportDetail("verbose")).toBe(false);
    expect(isExportDetail(2)).toBe(false);
  });
});
