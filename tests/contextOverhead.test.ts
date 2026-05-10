import { describe, expect, it } from "vitest";
import {
  BYTES_PER_TOKEN,
  MCP_TOKENS_PER_SERVER,
  SYSTEM_PROMPT_BASELINE_TOKENS,
  computeContextOverhead,
  median,
} from "@/lib/contextOverhead";
import type { SkillEntry } from "@/lib/indexer/types";
import type { HookEntry } from "@/lib/types";

/**
 * Minimal SkillEntry fixture — only the fields the aggregator reads.
 * `fileBytes` is what feeds the body-bytes ceiling; everything else is
 * present so the shape type-checks.
 */
function fakeSkill(fileBytes: number, opts: { disabled?: boolean } = {}): SkillEntry {
  return {
    id: `skill:user:user:${fileBytes}-${opts.disabled ? "off" : "on"}`,
    kind: "skill",
    slug: "test",
    name: "test",
    source: "user",
    filePath: "/tmp/test/SKILL.md",
    bodyExcerpt: "",
    frontmatter: {},
    mtime: "2026-05-10T00:00:00.000Z",
    ctime: "2026-05-10T00:00:00.000Z",
    layout: "bundled",
    provenance: { kind: "user-local" },
    fileBytes,
    disabled: opts.disabled,
  };
}

function fakeHooks(n: number): HookEntry[] {
  const out: HookEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      event: "PostToolUse",
      matcher: `tool-${i}`,
      commands: [{ type: "command", command: `echo h${i}` }],
      source: "user",
      sourcePath: "/tmp/.claude/settings.json",
    });
  }
  return out;
}

describe("median", () => {
  it("returns 0 for empty input", () => {
    expect(median([])).toBe(0);
  });

  it("returns the single value for length-1 input", () => {
    expect(median([42])).toBe(42);
  });

  it("returns the middle value for odd-length input", () => {
    expect(median([7, 1, 3])).toBe(3);
  });

  it("rounds the mean of the two middle values for even-length input", () => {
    expect(median([2, 4, 6, 8])).toBe(5);
    expect(median([1, 2])).toBe(2);
  });
});

describe("computeContextOverhead", () => {
  it("produces a deterministic snapshot for a fixture portfolio", () => {
    const skills = Array.from({ length: 10 }, () => fakeSkill(4_000));
    const hookEntries = fakeHooks(4);
    // Mirror the aggregator's metadata-stripping for the expected size.
    const hooksJsonBytes = Buffer.byteLength(
      JSON.stringify(
        hookEntries.map((h) => ({ event: h.event, matcher: h.matcher, commands: h.commands })),
      ),
      "utf-8",
    );

    const breakdown = computeContextOverhead({
      mcpServerCount: 3,
      skills,
      hookEntries,
      memoryBytes: 8_000,
      observedSamples: [],
    });

    expect(breakdown.theoreticalMinTokens).toBe(SYSTEM_PROMPT_BASELINE_TOKENS);
    expect(breakdown.observedTokens).toBeNull();
    expect(breakdown.unaccountedTokens).toBeNull();
    expect(breakdown.sampleSize).toBe(0);

    expect(breakdown.rows.map((r) => r.source)).toEqual([
      "baseline",
      "mcp",
      "skills",
      "hooks",
      "memory",
    ]);

    const byKey = Object.fromEntries(breakdown.rows.map((r) => [r.source, r]));
    expect(byKey.baseline.tokens).toBe(3_200);
    expect(byKey.mcp.tokens).toBe(3 * MCP_TOKENS_PER_SERVER);
    expect(byKey.skills.tokens).toBe(40_000 / BYTES_PER_TOKEN);
    expect(byKey.hooks.tokens).toBe(Math.round(hooksJsonBytes / BYTES_PER_TOKEN));
    expect(byKey.memory.tokens).toBe(8_000 / BYTES_PER_TOKEN);

    expect(breakdown.knownTokens).toBe(
      byKey.baseline.tokens +
        byKey.mcp.tokens +
        byKey.skills.tokens +
        byKey.hooks.tokens +
        byKey.memory.tokens,
    );

    expect(byKey.mcp.actionHref).toBe("/config?type=mcp");
    expect(byKey.skills.actionHref).toBe("/skills");
    expect(byKey.hooks.actionHref).toBe("/config?type=hooks");
    expect(byKey.memory.actionHref).toBe("/memory");
    expect(byKey.baseline.actionHref).toBeUndefined();
  });

  it("appends an 'unaccounted' row when observed > known", () => {
    const breakdown = computeContextOverhead({
      mcpServerCount: 0,
      skills: [],
      hookEntries: [],
      memoryBytes: 0,
      observedSamples: [10_000, 12_000, 14_000],
    });

    expect(breakdown.observedTokens).toBe(12_000);
    expect(breakdown.knownTokens).toBe(SYSTEM_PROMPT_BASELINE_TOKENS);
    expect(breakdown.unaccountedTokens).toBe(12_000 - 3_200);

    const last = breakdown.rows[breakdown.rows.length - 1];
    expect(last.source).toBe("unknown");
    expect(last.tokens).toBe(8_800);
    expect(last.actionHref).toBeUndefined();
  });

  it("clamps unaccountedTokens at zero when known exceeds observed", () => {
    const breakdown = computeContextOverhead({
      mcpServerCount: 50,
      skills: [],
      hookEntries: [],
      memoryBytes: 0,
      observedSamples: [5_000],
    });

    expect(breakdown.knownTokens).toBeGreaterThan(breakdown.observedTokens!);
    expect(breakdown.unaccountedTokens).toBe(0);
    expect(breakdown.rows.find((r) => r.source === "unknown")).toBeUndefined();
  });

  it("matches the verify check: portfolio sum within +/-10% of manual sum", () => {
    // Plan: "With known config (e.g. 3 MCP servers, 12 skills), bar matches
    // manual sum within +/-10%." Fixed-byte fixture so the assertion is
    // deterministic — the +/-10% applies to live data, not this synthetic.
    const skills = Array.from({ length: 12 }, () => fakeSkill(4_000));
    const breakdown = computeContextOverhead({
      mcpServerCount: 3,
      skills,
      hookEntries: [],
      memoryBytes: 6_000,
      observedSamples: [],
    });

    // 3,200 (baseline) + 3 × 1,250 (mcp) + 12,000 (skills) + 0 (empty hooks short-circuit) + 1,500 (memory) = 20,450
    const manual = 3_200 + 3 * 1_250 + 12_000 + 0 + 1_500;
    expect(breakdown.knownTokens).toBe(manual);
    expect(Math.abs(breakdown.knownTokens - 20_000) / 20_000).toBeLessThan(0.1);
  });

  it("emits 'none' detail strings for empty sources", () => {
    const breakdown = computeContextOverhead({
      mcpServerCount: 0,
      skills: [],
      hookEntries: [],
      memoryBytes: 0,
      observedSamples: [],
    });

    const byKey = Object.fromEntries(breakdown.rows.map((r) => [r.source, r]));
    expect(byKey.mcp.detail).toBe("none");
    expect(byKey.skills.detail).toBe("none");
    expect(byKey.hooks.detail).toBe("none");
    expect(byKey.memory.detail).toBe("none");
  });

  it("computes the median for observed samples, not the mean", () => {
    const breakdown = computeContextOverhead({
      mcpServerCount: 0,
      skills: [],
      hookEntries: [],
      memoryBytes: 0,
      observedSamples: [100, 100, 100, 100, 10_000],
    });

    expect(breakdown.observedTokens).toBe(100);
    expect(breakdown.sampleSize).toBe(5);
  });

  it("ignores skills with missing fileBytes (backwards compat)", () => {
    // Older catalog entries written before fileBytes was introduced have
    // undefined fileBytes — they should contribute 0 to the skill total.
    const skills: SkillEntry[] = [
      fakeSkill(2_000),
      { ...fakeSkill(0), fileBytes: undefined },
      fakeSkill(2_000),
    ];

    const breakdown = computeContextOverhead({
      mcpServerCount: 0,
      skills,
      hookEntries: [],
      memoryBytes: 0,
      observedSamples: [],
    });

    const skillRow = breakdown.rows.find((r) => r.source === "skills")!;
    expect(skillRow.tokens).toBe(4_000 / BYTES_PER_TOKEN);
  });

  it("excludes disabled skills from byte and count totals", () => {
    // walkUserSkills returns active + disabled in one list — disabled
    // skills live under ~/.claude/skills-disabled and aren't loaded by
    // Claude Code, so they shouldn't show up in the overhead estimate.
    const skills: SkillEntry[] = [
      fakeSkill(2_000),                      // active
      fakeSkill(10_000, { disabled: true }), // archived — must not count
      fakeSkill(2_000),                      // active
    ];

    const breakdown = computeContextOverhead({
      mcpServerCount: 0,
      skills,
      hookEntries: [],
      memoryBytes: 0,
      observedSamples: [],
    });

    const skillRow = breakdown.rows.find((r) => r.source === "skills")!;
    expect(skillRow.tokens).toBe(4_000 / BYTES_PER_TOKEN);
    expect(skillRow.detail).toContain("2 skills");
  });

  it("strips local-only metadata before sizing the hook payload", () => {
    // HookEntry carries `source` + `sourcePath` (absolute file path)
    // for Project Minder attribution — Claude only ever sees
    // { event, matcher, commands }. Including the local fields would
    // overstate the hook payload (often by ~50% from the path alone).
    const longPath = "/very/long/absolute/path/to/.claude/settings.json";
    const entries: HookEntry[] = [
      {
        event: "PostToolUse",
        matcher: "Edit",
        commands: [{ type: "command", command: "echo done" }],
        source: "user",
        sourcePath: longPath,
      },
    ];

    const breakdown = computeContextOverhead({
      mcpServerCount: 0,
      skills: [],
      hookEntries: entries,
      memoryBytes: 0,
      observedSamples: [],
    });

    const hookRow = breakdown.rows.find((r) => r.source === "hooks")!;
    // The expected size is the JSON of just { event, matcher, commands }.
    const expectedBytes = Buffer.byteLength(
      JSON.stringify([
        {
          event: "PostToolUse",
          matcher: "Edit",
          commands: [{ type: "command", command: "echo done" }],
        },
      ]),
      "utf-8",
    );
    expect(hookRow.tokens).toBe(Math.round(expectedBytes / BYTES_PER_TOKEN));
    // Sanity check: stripping the path actually reduced the count.
    const fullBytes = Buffer.byteLength(JSON.stringify(entries), "utf-8");
    expect(expectedBytes).toBeLessThan(fullBytes);
  });
});
