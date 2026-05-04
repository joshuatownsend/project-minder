import { describe, it, expect } from "vitest";
import {
  runWasteOptimizer,
  _internal,
  type WasteFinding,
} from "@/lib/scanner/wasteOptimizer";
import type { UsageTurn, ToolCall } from "@/lib/usage/types";
import type { McpServer } from "@/lib/types";
import type { AgentEntry, SkillEntry } from "@/lib/indexer/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function turn(overrides: Partial<UsageTurn> & {
  role: "user" | "assistant";
  toolCalls?: ToolCall[];
}): UsageTurn {
  return {
    timestamp: overrides.timestamp ?? "2026-01-01T00:00:00Z",
    sessionId: overrides.sessionId ?? "s1",
    projectSlug: "p",
    projectDirName: "p",
    model: overrides.model ?? "claude-sonnet-4-6",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: overrides.toolCalls ?? [],
    ...overrides,
  };
}

function read(path: string, sessionId = "s1", timestamp = "2026-01-01T00:00:00Z"): UsageTurn {
  return turn({
    role: "assistant",
    sessionId,
    timestamp,
    toolCalls: [{ name: "Read", arguments: { file_path: path } }],
  });
}

function edit(path: string, sessionId = "s1", timestamp = "2026-01-01T00:00:00Z"): UsageTurn {
  return turn({
    role: "assistant",
    sessionId,
    timestamp,
    toolCalls: [{ name: "Edit", arguments: { file_path: path } }],
  });
}

function mcpCall(server: string, tool = "do"): UsageTurn {
  return turn({
    role: "assistant",
    toolCalls: [{ name: `mcp__${server}__${tool}` }],
  });
}

function makeServer(name: string): McpServer {
  return {
    name,
    transport: "stdio",
    source: "project",
    sourcePath: ".mcp.json",
  };
}

// ── Detector tests ───────────────────────────────────────────────────────────

describe("detectJunkReads", () => {
  it("returns null when no junk paths are read", () => {
    const r = _internal.detectJunkReads([read("src/foo.ts"), read("README.md")]);
    expect(r.finding).toBeNull();
  });

  it("matches forward-slash junk paths", () => {
    const r = _internal.detectJunkReads([read("src/node_modules/foo/index.js")]);
    expect(r.finding?.code).toBe("junk-reads");
    expect(r.hits.length).toBe(1);
  });

  it("matches Windows backslash junk paths", () => {
    const r = _internal.detectJunkReads([read("C:\\dev\\proj\\.next\\static\\bundle.js")]);
    expect(r.finding?.code).toBe("junk-reads");
  });

  it("escalates severity from low → medium → high based on count", () => {
    const lo = _internal.detectJunkReads([read(".git/HEAD")]);
    expect(lo.finding?.severity).toBe("low");

    const md = _internal.detectJunkReads(
      Array.from({ length: 5 }, (_, i) => read(`dist/file-${i}.js`))
    );
    expect(md.finding?.severity).toBe("medium");

    const hi = _internal.detectJunkReads(
      Array.from({ length: 25 }, (_, i) => read(`build/file-${i}.js`))
    );
    expect(hi.finding?.severity).toBe("high");
  });

  it("ignores non-Read tool calls against junk paths", () => {
    const t = turn({
      role: "assistant",
      toolCalls: [{ name: "Bash", arguments: { command: "ls node_modules/" } }],
    });
    const r = _internal.detectJunkReads([t]);
    expect(r.finding).toBeNull();
  });
});

describe("detectDuplicateReads", () => {
  it("flags a file read in 3+ sessions without intervening edits", () => {
    const turns: UsageTurn[] = [
      read("src/foo.ts", "s1", "2026-01-01T00:00:00Z"),
      read("src/foo.ts", "s2", "2026-01-02T00:00:00Z"),
      read("src/foo.ts", "s3", "2026-01-03T00:00:00Z"),
    ];
    const f = _internal.detectDuplicateReads(turns);
    expect(f).not.toBeNull();
    expect(f!.code).toBe("duplicate-reads");
  });

  it("does not flag when an edit happens between reads", () => {
    const turns: UsageTurn[] = [
      read("src/foo.ts", "s1", "2026-01-01T00:00:00Z"),
      read("src/foo.ts", "s2", "2026-01-02T00:00:00Z"),
      edit("src/foo.ts", "s2", "2026-01-02T01:00:00Z"),
      read("src/foo.ts", "s3", "2026-01-03T00:00:00Z"),
    ];
    const f = _internal.detectDuplicateReads(turns);
    expect(f).toBeNull();
  });

  it("counts reads as separate sessions", () => {
    // 2 sessions only — below the 3-session threshold.
    const turns: UsageTurn[] = [
      read("src/foo.ts", "s1", "2026-01-01T00:00:00Z"),
      read("src/foo.ts", "s2", "2026-01-02T00:00:00Z"),
    ];
    expect(_internal.detectDuplicateReads(turns)).toBeNull();
  });

  it("escalates severity at high session counts", () => {
    const turns: UsageTurn[] = Array.from({ length: 9 }, (_, i) =>
      read("src/foo.ts", `s${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`)
    );
    const f = _internal.detectDuplicateReads(turns);
    expect(f?.severity).toBe("high");
  });
});

describe("detectUnusedMcpServers", () => {
  it("returns null when no servers are configured", () => {
    expect(_internal.detectUnusedMcpServers([], [])).toBeNull();
  });

  it("flags configured servers with zero invocations", () => {
    const f = _internal.detectUnusedMcpServers(
      [mcpCall("alpha")],
      [makeServer("alpha"), makeServer("beta"), makeServer("gamma")]
    );
    expect(f?.code).toBe("unused-mcp-servers");
    expect(f?.title).toContain("2 MCP servers");
    expect(f?.severity).toBe("medium");
  });

  it("returns null when every configured server is used", () => {
    const f = _internal.detectUnusedMcpServers(
      [mcpCall("alpha"), mcpCall("beta")],
      [makeServer("alpha"), makeServer("beta")]
    );
    expect(f).toBeNull();
  });

  it("dedups servers configured under multiple scopes", () => {
    const f = _internal.detectUnusedMcpServers(
      [],
      [
        { ...makeServer("alpha"), source: "project" },
        { ...makeServer("alpha"), source: "local" },
      ]
    );
    expect(f?.title).toContain("1 MCP server");
  });
});

describe("detectGhostCapabilities", () => {
  function agentEntry(slug: string): AgentEntry {
    return {
      kind: "agent",
      id: `a:${slug}`,
      slug,
      name: slug,
      source: "user",
      filePath: `~/.claude/agents/${slug}.md`,
      bodyExcerpt: "",
      frontmatter: {},
      mtime: "",
      ctime: "",
      provenance: { kind: "user-local" },
    };
  }
  function skillEntry(slug: string): SkillEntry {
    return {
      kind: "skill",
      layout: "standalone",
      id: `s:${slug}`,
      slug,
      name: slug,
      source: "user",
      filePath: `~/.claude/skills/${slug}.md`,
      bodyExcerpt: "",
      frontmatter: {},
      mtime: "",
      ctime: "",
      provenance: { kind: "user-local" },
    };
  }

  it("returns null when nothing has been invoked", () => {
    // No invocations at all → not a useful signal; skip.
    const f = _internal.detectGhostCapabilities(
      [],
      [agentEntry("explore"), agentEntry("plan")],
      [skillEntry("simplify")]
    );
    expect(f).toBeNull();
  });

  it("flags ghosts when some capabilities are used", () => {
    const taskTurn = turn({
      role: "assistant",
      toolCalls: [{ name: "Task", arguments: { subagent_type: "explore" } }],
    });
    const f = _internal.detectGhostCapabilities(
      [taskTurn],
      [agentEntry("explore"), agentEntry("plan"), agentEntry("dead1"), agentEntry("dead2")],
      [skillEntry("simplify"), skillEntry("dead3")]
    );
    expect(f).not.toBeNull();
    expect(f!.code).toBe("ghost-capabilities");
  });

  it("does not flag when below the noise floor (<3 ghosts)", () => {
    const taskTurn = turn({
      role: "assistant",
      toolCalls: [{ name: "Task", arguments: { subagent_type: "explore" } }],
    });
    const f = _internal.detectGhostCapabilities(
      [taskTurn],
      [agentEntry("explore"), agentEntry("plan")], // only 1 ghost
      []
    );
    expect(f).toBeNull();
  });

  it("does not flag when nothing has been invoked AND there are entries (anti-false-positive)", () => {
    // 3 agents indexed, zero invocations. Without the total-unused
    // short-circuit this would flag every fresh project.
    const f = _internal.detectGhostCapabilities(
      [],
      [agentEntry("explore"), agentEntry("plan"), agentEntry("review")],
      []
    );
    expect(f).toBeNull();
  });

  it("normalizes case when matching subagent_type to agent slug", () => {
    const taskTurn = turn({
      role: "assistant",
      toolCalls: [{ name: "Task", arguments: { subagent_type: "Explore" } }],
    });
    // 4 ghosts after the case-insensitive match would leave 3 still
    // above the noise floor. Without normalization, "Explore" wouldn't
    // match agentEntry("explore") and we'd report 4 ghosts.
    const f = _internal.detectGhostCapabilities(
      [taskTurn],
      [
        agentEntry("explore"),
        agentEntry("plan"),
        agentEntry("dead1"),
        agentEntry("dead2"),
        agentEntry("dead3"),
      ],
      []
    );
    expect(f?.title).toMatch(/4 unused/);
  });
});

describe("detectLowReadEditRatio", () => {
  it("returns null with insufficient activity", () => {
    expect(_internal.detectLowReadEditRatio([read("a.ts"), edit("a.ts")])).toBeNull();
  });

  it("flags a project where most sessions edit > 3× their reads", () => {
    const turns: UsageTurn[] = [];
    // 4 sessions, all heavy-edit-light-read.
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < 10; i++) {
        turns.push(edit("a.ts", `s${s}`));
      }
      turns.push(read("a.ts", `s${s}`));
    }
    const f = _internal.detectLowReadEditRatio(turns);
    expect(f).not.toBeNull();
    expect(f!.code).toBe("low-read-edit-ratio");
  });

  it("doesn't flag when balanced", () => {
    const turns: UsageTurn[] = [];
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < 5; i++) {
        turns.push(read("a.ts", `s${s}`));
        turns.push(edit("a.ts", `s${s}`));
      }
    }
    expect(_internal.detectLowReadEditRatio(turns)).toBeNull();
  });

  it("flags zero-reads-many-edits without divide-by-zero", () => {
    // Sessions with 5+ edits and zero reads: edits/Math.max(reads,1) > 3
    // hit's the > branch via reads === 0 fallback.
    const turns: UsageTurn[] = [];
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < 8; i++) {
        turns.push(edit("a.ts", `s${s}`));
      }
    }
    const f = _internal.detectLowReadEditRatio(turns);
    expect(f).not.toBeNull();
    expect(f!.severity).toBe("high");
  });
});

// ── Grade rollup ────────────────────────────────────────────────────────────

describe("gradeFor", () => {
  function fake(severity: "high" | "medium" | "low"): WasteFinding {
    return {
      code: "junk-reads",
      severity,
      title: "x",
      explanation: "x",
      fix: "x",
      tokensSaveable: null,
    };
  }
  it("A on no findings", () => {
    expect(_internal.gradeFor([])).toBe("A");
  });
  it("A when all findings are low", () => {
    expect(_internal.gradeFor([fake("low"), fake("low")])).toBe("A");
  });
  it("B on 1–2 medium", () => {
    expect(_internal.gradeFor([fake("medium")])).toBe("B");
    expect(_internal.gradeFor([fake("medium"), fake("medium")])).toBe("B");
  });
  it("C on 3+ medium", () => {
    expect(_internal.gradeFor([fake("medium"), fake("medium"), fake("medium")])).toBe("C");
  });
  it("D on 1 high", () => {
    expect(_internal.gradeFor([fake("high")])).toBe("D");
  });
  it("F on 2+ high", () => {
    expect(_internal.gradeFor([fake("high"), fake("high")])).toBe("F");
  });
  it("F on >8 total findings regardless of severity mix", () => {
    expect(_internal.gradeFor(Array.from({ length: 9 }, () => fake("low")))).toBe("F");
  });
});

// ── End-to-end runWasteOptimizer ────────────────────────────────────────────

describe("runWasteOptimizer", () => {
  it("returns A grade with no findings on a clean project", () => {
    const result = runWasteOptimizer({
      turns: [],
      configuredMcpServers: [],
      agents: [],
      skills: [],
    });
    expect(result.grade).toBe("A");
    expect(result.findings).toHaveLength(0);
  });

  it("aggregates findings + grades correctly", () => {
    // Junk reads (low) + duplicate reads (low) = grade A still since both low
    const turns: UsageTurn[] = [
      read("node_modules/x/index.js", "s1", "2026-01-01T00:00:00Z"),
      read("src/foo.ts", "s1", "2026-01-01T00:01:00Z"),
      read("src/foo.ts", "s2", "2026-01-02T00:00:00Z"),
      read("src/foo.ts", "s3", "2026-01-03T00:00:00Z"),
    ];
    const result = runWasteOptimizer({
      turns,
      configuredMcpServers: [],
      agents: [],
      skills: [],
    });
    expect(result.findings.some((f) => f.code === "junk-reads")).toBe(true);
    expect(result.findings.some((f) => f.code === "duplicate-reads")).toBe(true);
    // junk-reads (1 hit = low) + dup-reads (3 sessions = low) → A
    expect(result.grade).toBe("A");
  });

  it("sorts findings high → medium → low", () => {
    // Build inputs that produce: junk-reads high (25 hits) + 1 unused MCP (low)
    const junkTurns = Array.from({ length: 25 }, (_, i) =>
      read(`build/x-${i}.js`, `s${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`)
    );
    const result = runWasteOptimizer({
      turns: junkTurns,
      configuredMcpServers: [makeServer("unused-server")],
      agents: [],
      skills: [],
    });
    expect(result.findings[0].severity).toBe("high");
    // Lower severity findings should come after.
    expect(["medium", "low"]).toContain(result.findings[result.findings.length - 1].severity);
  });
});
