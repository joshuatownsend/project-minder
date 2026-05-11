import { describe, it, expect } from "vitest";
import { groupAgentCalls } from "@/lib/usage/agentParser";
import { groupSkillCalls } from "@/lib/usage/skillParser";
import { assistantTurn } from "./fixtures/turn";

// Phase 4.1: period filter on the file-parse path. The aggregators
// already had role + falsy-string guards; the new optional `sinceMs`
// argument additionally skips any turn whose `timestamp` predates the
// bound. Turns without a parseable timestamp are skipped under any
// filter (defensive — the DB schema disallows null `tu.ts` from the
// session aggregate, and the file-parse path should mirror that).

const NOW_MS = Date.parse("2026-05-11T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function agentCall(ts: string) {
  return assistantTurn({
    timestamp: ts,
    toolCalls: [{ name: "Agent", arguments: { subagent_type: "code-reviewer" } }],
  });
}

function skillCall(ts: string) {
  return assistantTurn({
    timestamp: ts,
    toolCalls: [{ name: "Skill", arguments: { skill: "test-skill" } }],
  });
}

describe("groupAgentCalls — sinceMs filter", () => {
  it("returns all calls when sinceMs is undefined (back-compat)", () => {
    const turns = [
      agentCall("2026-05-01T00:00:00Z"),
      agentCall("2026-05-10T00:00:00Z"),
      agentCall("2026-05-11T11:00:00Z"),
    ];
    const stats = groupAgentCalls(turns);
    expect(stats).toHaveLength(1);
    expect(stats[0].invocations).toBe(3);
  });

  it("filters out turns strictly before sinceMs", () => {
    const turns = [
      agentCall("2026-05-10T11:00:00Z"), // 25h ago — out
      agentCall("2026-05-11T11:00:00Z"), // 1h ago — in
      agentCall("2026-05-11T11:30:00Z"), // 30m ago — in
    ];
    const stats = groupAgentCalls(turns, NOW_MS - DAY);
    expect(stats).toHaveLength(1);
    expect(stats[0].invocations).toBe(2);
  });

  it("returns empty when no turn falls inside the window", () => {
    const turns = [agentCall("2026-04-01T00:00:00Z"), agentCall("2026-04-15T00:00:00Z")];
    const stats = groupAgentCalls(turns, NOW_MS - DAY);
    expect(stats).toEqual([]);
  });

  it("skips turns with unparseable timestamps under any filter", () => {
    const turns = [
      assistantTurn({
        timestamp: "not-a-date",
        toolCalls: [{ name: "Agent", arguments: { subagent_type: "x" } }],
      }),
      agentCall("2026-05-11T11:00:00Z"),
    ];
    const stats = groupAgentCalls(turns, NOW_MS - DAY);
    expect(stats).toHaveLength(1);
    expect(stats[0].invocations).toBe(1);
  });

  it("includes a turn whose ts equals the lower bound (inclusive)", () => {
    const bound = NOW_MS - HOUR;
    const exactly = new Date(bound).toISOString();
    const stats = groupAgentCalls([agentCall(exactly)], bound);
    expect(stats[0]?.invocations).toBe(1);
  });
});

describe("groupSkillCalls — sinceMs filter", () => {
  it("filters skills the same way agents are filtered", () => {
    const turns = [
      skillCall("2026-05-10T11:00:00Z"),
      skillCall("2026-05-11T11:00:00Z"),
      skillCall("2026-05-11T11:30:00Z"),
    ];
    const stats = groupSkillCalls(turns, NOW_MS - DAY);
    expect(stats).toHaveLength(1);
    expect(stats[0].invocations).toBe(2);
  });

  it("is a no-op when sinceMs is undefined", () => {
    const turns = [skillCall("2026-05-01T00:00:00Z"), skillCall("2026-05-11T00:00:00Z")];
    expect(groupSkillCalls(turns)[0].invocations).toBe(2);
  });
});
