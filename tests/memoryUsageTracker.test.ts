import { describe, it, expect } from "vitest";
import {
  aggregateMemoryReads,
  canonicalMemoryKey,
  isMemoryPath,
} from "@/lib/memory/usageTracker";
import type { UsageTurn } from "@/lib/usage/types";
import type { ProjectData } from "@/lib/types";

// Pure-function tests for the JSONL replay aggregator. The production entry
// point `getMemoryUsage` wraps a single-flight cache + DB write-through; we
// don't exercise that here because it's a thin glue layer over the pure
// aggregator below.

function project(slug: string, projectPath: string): ProjectData {
  return {
    slug,
    name: slug,
    path: projectPath,
    status: "active",
    dependencies: [],
    dockerPorts: [],
    externalServices: [],
    scannedAt: new Date().toISOString(),
    claudeMdAudit: { hasClaudeMd: false, findings: [] },
  };
}

function makeAssistantTurn(
  timestamp: string,
  toolName: string,
  args: Record<string, unknown>,
): UsageTurn {
  return {
    timestamp,
    sessionId: "s1",
    projectSlug: "p",
    projectDirName: "p",
    model: "claude-opus-4",
    role: "assistant",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [{ name: toolName, arguments: args }],
  };
}

function projectClaudeMdSet(paths: string[]): Set<string> {
  return new Set(paths.map((p) => `${p.replace(/\\/g, "/").toLowerCase()}/claude.md`));
}

describe("isMemoryPath", () => {
  it("matches user CLAUDE.md (home-relative shape)", () => {
    expect(isMemoryPath("C:\\Users\\joshu\\.claude\\CLAUDE.md", projectClaudeMdSet([]))).toBe(true);
    expect(isMemoryPath("/home/josh/.claude/CLAUDE.md", projectClaudeMdSet([]))).toBe(true);
  });

  it("matches auto-memory body files", () => {
    expect(
      isMemoryPath(
        "C:\\Users\\joshu\\.claude\\projects\\C--dev-foo\\memory\\feedback_design.md",
        projectClaudeMdSet([]),
      ),
    ).toBe(true);
    expect(
      isMemoryPath(
        "/home/josh/.claude/projects/abc/memory/user_role.md",
        projectClaudeMdSet([]),
      ),
    ).toBe(true);
  });

  it("matches a scanned project's CLAUDE.md", () => {
    expect(isMemoryPath("C:\\dev\\foo\\CLAUDE.md", projectClaudeMdSet(["C:\\dev\\foo"]))).toBe(true);
    expect(isMemoryPath("/repos/foo/CLAUDE.md", projectClaudeMdSet(["/repos/foo"]))).toBe(true);
  });

  it("is case-insensitive on the basename + extension", () => {
    expect(
      isMemoryPath("C:\\Users\\joshu\\.CLAUDE\\claude.md", projectClaudeMdSet([])),
    ).toBe(true);
  });

  it("rejects non-memory paths", () => {
    expect(isMemoryPath("C:\\dev\\foo\\src\\index.ts", projectClaudeMdSet(["C:\\dev\\foo"]))).toBe(false);
    expect(isMemoryPath("/home/josh/.claude/projects/abc/sessions/x.jsonl", projectClaudeMdSet([]))).toBe(false);
    expect(isMemoryPath("", projectClaudeMdSet([]))).toBe(false);
  });

  it("rejects auto-memory paths that aren't .md", () => {
    expect(
      isMemoryPath(
        "/home/josh/.claude/projects/abc/memory/notes.txt",
        projectClaudeMdSet([]),
      ),
    ).toBe(false);
  });
});

describe("aggregateMemoryReads", () => {
  const memPath = "C:\\Users\\joshu\\.claude\\projects\\C--dev-foo\\memory\\user_role.md";
  const memKey = canonicalMemoryKey(memPath);

  it("counts Read events targeting memory files", () => {
    const sessions = new Map<string, UsageTurn[]>([
      [
        "s1",
        [
          makeAssistantTurn("2026-05-10T10:00:00Z", "Read", { file_path: memPath }),
          makeAssistantTurn("2026-05-10T11:00:00Z", "Read", { file_path: memPath }),
        ],
      ],
    ]);
    const result = aggregateMemoryReads(sessions, []);
    const stat = result.get(memKey);
    expect(stat?.readCount).toBe(2);
    expect(stat?.lastReadAt).toBe("2026-05-10T11:00:00Z");
  });

  it("ignores Read events on non-memory paths", () => {
    const sessions = new Map<string, UsageTurn[]>([
      [
        "s1",
        [
          makeAssistantTurn("2026-05-10T10:00:00Z", "Read", {
            file_path: "C:\\dev\\foo\\src\\index.ts",
          }),
        ],
      ],
    ]);
    const result = aggregateMemoryReads(sessions, [project("foo", "C:\\dev\\foo")]);
    expect(result.size).toBe(0);
  });

  it("ignores Grep / Glob even when path looks like a memory dir", () => {
    const memDir = "C:\\Users\\joshu\\.claude\\projects\\C--dev-foo\\memory";
    const sessions = new Map<string, UsageTurn[]>([
      [
        "s1",
        [
          makeAssistantTurn("2026-05-10T10:00:00Z", "Grep", { pattern: "x", path: memDir }),
          makeAssistantTurn("2026-05-10T10:01:00Z", "Glob", { pattern: "*.md", path: memDir }),
        ],
      ],
    ]);
    // Per the tracker docstring: Grep/Glob have dir-level targets that we
    // can't break down per-file, so they're excluded from the file-keyed map.
    const result = aggregateMemoryReads(sessions, []);
    expect(result.size).toBe(0);
  });

  it("aggregates across multiple sessions and picks the latest lastReadAt", () => {
    const sessions = new Map<string, UsageTurn[]>([
      [
        "s1",
        [makeAssistantTurn("2026-05-10T10:00:00Z", "Read", { file_path: memPath })],
      ],
      [
        "s2",
        [
          makeAssistantTurn("2026-05-09T10:00:00Z", "Read", { file_path: memPath }),
          makeAssistantTurn("2026-05-11T08:00:00Z", "Read", { file_path: memPath }),
        ],
      ],
    ]);
    const result = aggregateMemoryReads(sessions, []);
    expect(result.get(memKey)?.readCount).toBe(3);
    expect(result.get(memKey)?.lastReadAt).toBe("2026-05-11T08:00:00Z");
  });

  it("skips assistant turns whose Read args lack file_path", () => {
    const sessions = new Map<string, UsageTurn[]>([
      [
        "s1",
        [makeAssistantTurn("2026-05-10T10:00:00Z", "Read", { not_file_path: memPath })],
      ],
    ]);
    expect(aggregateMemoryReads(sessions, []).size).toBe(0);
  });

  it("attributes reads to the scanned-project CLAUDE.md when path matches", () => {
    const projectClaudeMd = "C:\\dev\\foo\\CLAUDE.md";
    const sessions = new Map<string, UsageTurn[]>([
      [
        "s1",
        [makeAssistantTurn("2026-05-10T10:00:00Z", "Read", { file_path: projectClaudeMd })],
      ],
    ]);
    const result = aggregateMemoryReads(sessions, [project("foo", "C:\\dev\\foo")]);
    expect(result.get(canonicalMemoryKey(projectClaudeMd))?.readCount).toBe(1);
  });

  it("ignores user-role turns (defensive — non-assistant tool calls shouldn't exist but check anyway)", () => {
    const t = makeAssistantTurn("2026-05-10T10:00:00Z", "Read", { file_path: memPath });
    t.role = "user";
    const sessions = new Map<string, UsageTurn[]>([["s1", [t]]]);
    expect(aggregateMemoryReads(sessions, []).size).toBe(0);
  });
});
