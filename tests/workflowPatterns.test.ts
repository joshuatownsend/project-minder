import { describe, it, expect } from "vitest";
import { detectWorkflowPatterns } from "@/lib/usage/workflowPatterns";
import type { UsageTurn } from "@/lib/usage/types";
import type { SkillEntry } from "@/lib/indexer/types";
import type { SkillStats } from "@/lib/usage/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bashTurn(sessionId: string, commands: string[]): UsageTurn {
  return {
    timestamp: "2026-01-01T12:00:00.000Z",
    sessionId,
    projectSlug: "my-project",
    projectDirName: "C--dev-my-project",
    model: "claude-opus-4-5",
    role: "assistant",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: commands.map((cmd) => ({
      name: "Bash",
      arguments: { command: cmd },
    })),
  };
}

function userTurn(sessionId: string): UsageTurn {
  return {
    timestamp: "2026-01-01T12:00:00.000Z",
    sessionId,
    projectSlug: "my-project",
    projectDirName: "C--dev-my-project",
    model: "claude-opus-4-5",
    role: "user",
    inputTokens: 50,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
  };
}

// N sessions each running the same command sequence
function multiSessionTurns(n: number, commands: string[]): UsageTurn[] {
  return Array.from({ length: n }, (_, i) => bashTurn(`sess${i}`, commands));
}

function skillEntry(name: string, description?: string): SkillEntry {
  return {
    id: `skill-${name}`,
    slug: name,
    name,
    description,
    source: "user",
    filePath: `/skills/${name}.md`,
    bodyExcerpt: "",
    frontmatter: {},
    mtime: "2026-01-01T00:00:00.000Z",
    ctime: "2026-01-01T00:00:00.000Z",
    provenance: { kind: "user-local" },
    kind: "skill",
    layout: "standalone",
  };
}

function skillStat(name: string, invocations: number): SkillStats {
  return { name, invocations, projects: {}, sessions: [] };
}

// ─── detectWorkflowPatterns ───────────────────────────────────────────────────

describe("detectWorkflowPatterns", () => {
  // ─── Degenerate inputs ─────────────────────────────────────────────────────

  it("returns empty patterns for empty turns array", () => {
    const result = detectWorkflowPatterns({ turns: [] });
    expect(result.patterns).toHaveLength(0);
    expect(result.totalSessionsConsidered).toBe(0);
    expect(result.totalBashCalls).toBe(0);
  });

  it("ignores user turns — no patterns from user-only input", () => {
    const turns = [userTurn("s0"), userTurn("s1"), userTurn("s2")];
    const result = detectWorkflowPatterns({ turns });
    expect(result.patterns).toHaveLength(0);
    expect(result.totalSessionsConsidered).toBe(0);
  });

  it("returns empty when a single session runs bash (below minSessions)", () => {
    const result = detectWorkflowPatterns({
      turns: [bashTurn("s0", ["git status", "npm test"])],
    });
    expect(result.patterns).toHaveLength(0);
    expect(result.totalSessionsConsidered).toBe(1);
  });

  // ─── minSessions threshold ─────────────────────────────────────────────────

  it("excludes patterns appearing in only 2 sessions (default minSessions=3)", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(2, ["git status", "npm test"]),
    });
    expect(result.patterns).toHaveLength(0);
  });

  it("includes patterns appearing in exactly 3 sessions", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, ["git status", "npm test"]),
    });
    expect(result.patterns.length).toBeGreaterThan(0);
  });

  it("respects custom minSessions=2 override", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(2, ["git status", "npm test"]),
      minSessions: 2,
    });
    expect(result.patterns.length).toBeGreaterThan(0);
  });

  // ─── N-gram detection ──────────────────────────────────────────────────────

  it("detects 2-grams", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, ["git status", "npm test"]),
      sequenceLengths: [2],
    });
    expect(result.patterns.some((p) => p.fingerprint === "git>npm")).toBe(true);
  });

  it("detects 3-grams", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, ["git status", "npm test", "git commit -m x"]),
      sequenceLengths: [3],
    });
    expect(result.patterns.some((p) => p.fingerprint === "git>npm>git")).toBe(true);
  });

  it("detects 4-grams", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, ["git status", "npm test", "git add .", "git commit -m x"]),
      sequenceLengths: [4],
    });
    expect(result.patterns.some((p) => p.fingerprint === "git>npm>git>git")).toBe(true);
  });

  it("only generates n-grams for the requested sequenceLengths", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, ["git status", "npm test", "git commit -m x"]),
      sequenceLengths: [3],
    });
    // No 2-gram should appear when sequenceLengths=[3]
    expect(result.patterns.every((p) => p.binaries.length === 3)).toBe(true);
  });

  // ─── All-identical binary skip ─────────────────────────────────────────────

  it("skips windows where all binaries are identical", () => {
    // All three commands resolve to 'git', so every window is all-identical
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, ["git status", "git diff", "git log"]),
      sequenceLengths: [2, 3],
    });
    expect(result.patterns).toHaveLength(0);
  });

  it("keeps windows where at least one binary differs", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, ["git status", "npm test", "git commit -m x"]),
      sequenceLengths: [2],
    });
    expect(result.patterns.some((p) => p.fingerprint === "git>npm")).toBe(true);
  });

  // ─── Pattern field values ──────────────────────────────────────────────────

  it("sets occurrences to the count of distinct sessions", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(4, ["git status", "npm test"]),
      sequenceLengths: [2],
    });
    const p = result.patterns.find((x) => x.fingerprint === "git>npm");
    expect(p?.occurrences).toBe(4);
  });

  it("sets totalRuns to cumulative window occurrences across all sessions", () => {
    // Each session runs the 2-command sequence twice → 2 windows per session × 3 sessions = 6
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, ["git status", "npm test", "git status", "npm test"]),
      sequenceLengths: [2],
    });
    const p = result.patterns.find((x) => x.fingerprint === "git>npm");
    expect(p?.totalRuns).toBeGreaterThanOrEqual(6);
  });

  it("caps sampleSessionIds at 5", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(8, ["git status", "npm test"]),
      sequenceLengths: [2],
    });
    const p = result.patterns.find((x) => x.fingerprint === "git>npm");
    expect(p?.sampleSessionIds.length).toBeLessThanOrEqual(5);
  });

  it("sorts patterns by occurrences descending", () => {
    const turns = [
      // "git>npm" in 4 sessions
      ...multiSessionTurns(4, ["git status", "npm test"]),
      // "npm>npx" in 3 different sessions
      ...Array.from({ length: 3 }, (_, i) =>
        bashTurn(`other${i}`, ["npm install", "npx tsc"])
      ),
    ];
    const result = detectWorkflowPatterns({ turns, sequenceLengths: [2] });
    expect(result.patterns.length).toBeGreaterThanOrEqual(2);
    expect(result.patterns[0].occurrences).toBeGreaterThanOrEqual(
      result.patterns[1].occurrences
    );
  });

  // ─── Pattern cap ───────────────────────────────────────────────────────────

  it("caps output at 50 patterns", () => {
    // 60 unique tool binaries → 59 distinct 2-grams, all in 3 sessions
    const commands = Array.from({ length: 60 }, (_, i) => `tool${i} run`);
    const turns = Array.from({ length: 3 }, (_, i) =>
      bashTurn(`big${i}`, commands)
    );
    const result = detectWorkflowPatterns({ turns, sequenceLengths: [2] });
    expect(result.patterns.length).toBeLessThanOrEqual(50);
  });

  // ─── Suggested skill name ──────────────────────────────────────────────────

  it("sets suggestedSkillName as kebab-joined binaries with '-flow' suffix", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, ["git status", "npm test"]),
      sequenceLengths: [2],
    });
    const p = result.patterns.find((x) => x.fingerprint === "git>npm");
    expect(p?.suggestedSkillName).toBe("git-npm-flow");
  });

  it("truncates suggestedSkillName to ≤40 chars with ellipsis when too long", () => {
    // 6 distinct binaries + "-flow" suffix produces >40 chars
    const commands = ["alpha run", "bravo run", "charlie run", "delta run", "echo run", "foxtrot run"];
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, commands),
      sequenceLengths: [6],
    });
    for (const p of result.patterns) {
      if (p.suggestedSkillName) {
        expect(p.suggestedSkillName.length).toBeLessThanOrEqual(40);
        if (p.suggestedSkillName.length === 40) {
          expect(p.suggestedSkillName.endsWith("...")).toBe(true);
        }
      }
    }
  });

  // ─── Skill catalog matching ────────────────────────────────────────────────

  it("leaves matchedSkill undefined when no skillsCatalog provided", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, ["git status", "npm test"]),
      sequenceLengths: [2],
    });
    for (const p of result.patterns) {
      expect(p.matchedSkill).toBeUndefined();
    }
  });

  it("matches a catalog skill when token overlap >= 2", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, ["git status", "npm test"]),
      sequenceLengths: [2],
      skillsCatalog: [
        skillEntry("git-npm-workflow", "Run git status and npm test"),
      ],
    });
    const p = result.patterns.find((x) => x.fingerprint === "git>npm");
    expect(p?.matchedSkill).toBeDefined();
    expect(p?.matchedSkill?.name).toBe("git-npm-workflow");
  });

  it("does not match a catalog skill when token overlap < 2", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, ["git status", "npm test"]),
      sequenceLengths: [2],
      skillsCatalog: [
        skillEntry("deploy-app", "Deploy the application to production"),
      ],
    });
    const p = result.patterns.find((x) => x.fingerprint === "git>npm");
    expect(p?.matchedSkill).toBeUndefined();
  });

  it("attaches invocation count from skillUsage to matched skill", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, ["git status", "npm test"]),
      sequenceLengths: [2],
      skillsCatalog: [skillEntry("git-npm-workflow", "git status and npm test")],
      skillUsage: [skillStat("git-npm-workflow", 42)],
    });
    const p = result.patterns.find((x) => x.fingerprint === "git>npm");
    expect(p?.matchedSkill?.invocations).toBe(42);
  });

  it("sets invocations to 0 when matched skill has no usage entry", () => {
    const result = detectWorkflowPatterns({
      turns: multiSessionTurns(3, ["git status", "npm test"]),
      sequenceLengths: [2],
      skillsCatalog: [skillEntry("git-npm-workflow", "git status and npm test")],
      skillUsage: [],
    });
    const p = result.patterns.find((x) => x.fingerprint === "git>npm");
    expect(p?.matchedSkill?.invocations).toBe(0);
  });

  // ─── Aggregate counters ────────────────────────────────────────────────────

  it("counts totalBashCalls across all sessions", () => {
    const turns = [
      bashTurn("s0", ["git status", "npm test"]),
      bashTurn("s1", ["git status"]),
    ];
    const result = detectWorkflowPatterns({ turns });
    expect(result.totalBashCalls).toBe(3);
  });

  it("counts totalSessionsConsidered only for sessions with valid bash binaries", () => {
    const turns = [
      bashTurn("s0", ["git status", "npm test"]),
      bashTurn("s1", ["git status"]),
      userTurn("u0"),
    ];
    const result = detectWorkflowPatterns({ turns });
    expect(result.totalSessionsConsidered).toBe(2);
  });
});
