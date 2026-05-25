import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import type { SubagentInfo } from "@/lib/types";

// Tests for `enrichSubagentsFromOtel` — populates per-subagent runtime
// metrics (cost, tokens, model, duration) on JSONL-derived SubagentInfo
// entries by consuming `computeAgentCostInvocationsFromOtel` output.
//
// JSONL sidechain data went away in Claude Code ~v2.1.150 (probed
// 2026-05-25: 0/214 sessions had isSidechain assistants). This
// enrichment is the working replacement.
//
// PR #163 fixed a critical overcounting bug: pre-PR the enrichment
// looked up cost by `subagent_completed.prompt.id` and assigned the
// full prompt-turn cost to EACH invocation in a parallel-dispatch
// batch. The new util distributes by `query_source` + token share,
// so the test fixtures here pin both the simple (one-invocation-per-
// prompt) and parallel (multiple-invocations-per-prompt) cases.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

async function reloadModules() {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return {
    enrichment: await import("@/lib/scanner/subagentEnrichment"),
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
  };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-subagent-enrich-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // Force MINDER_USE_DB on so getDb() returns a real connection.
  process.env.MINDER_USE_DB = "1";
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  delete process.env.MINDER_USE_DB;
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeSubagent(agentId: string, type: string): SubagentInfo {
  return { agentId, type, description: "", messageCount: 0, toolUsage: {} };
}

function insertSubagentCompleted(
  db: import("better-sqlite3").Database,
  args: {
    ts: string;
    sessionId: string;
    promptId: string;
    agentType: string;
    durationMs: number;
    model: string;
    totalTokens: number;
    totalToolUses?: number;
  },
): void {
  db.prepare(`
    INSERT INTO otel_events (event_name, ts, session_id, payload_json)
    VALUES ('subagent_completed', ?, ?, ?)
  `).run(args.ts, args.sessionId, JSON.stringify({
    attrs: {
      "session.id": args.sessionId,
      "prompt.id": args.promptId,
      "agent_type": args.agentType,
      "duration_ms": String(args.durationMs),
      "model": args.model,
      "total_tokens": String(args.totalTokens),
      "total_tool_uses": String(args.totalToolUses ?? 0),
    },
  }));
}

function insertApiRequest(
  db: import("better-sqlite3").Database,
  args: {
    ts: string;
    sessionId: string;
    promptId: string;
    querySource: string;
    costUsd: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate: number;
  },
): void {
  db.prepare(`
    INSERT INTO otel_events (event_name, ts, session_id, payload_json)
    VALUES ('api_request', ?, ?, ?)
  `).run(args.ts, args.sessionId, JSON.stringify({
    attrs: {
      "session.id": args.sessionId,
      "prompt.id": args.promptId,
      "query_source": args.querySource,
      "cost_usd": args.costUsd,
      "input_tokens": String(args.input),
      "output_tokens": String(args.output),
      "cache_read_tokens": String(args.cacheRead),
      "cache_creation_tokens": String(args.cacheCreate),
    },
  }));
}

describe.skipIf(!driverAvailable)("enrichSubagentsFromOtel", () => {
  it("populates cost/tokens/model/duration from OTEL events", async () => {
    const { enrichment, conn, mig } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "abc12345-0000-0000-0000-000000000001";
    insertSubagentCompleted(db, {
      ts: "2026-05-25T10:00:30Z",
      sessionId,
      promptId: "prompt-1",
      agentType: "code-architect",
      durationMs: 30_000,
      model: "claude-haiku-4-5",
      totalTokens: 12_345,
    });
    insertApiRequest(db, { ts: "2026-05-25T10:00:05Z", sessionId, promptId: "prompt-1", querySource: "agent:custom", costUsd: 0.12, input: 500, output: 50, cacheRead: 1000, cacheCreate: 200 });
    insertApiRequest(db, { ts: "2026-05-25T10:00:25Z", sessionId, promptId: "prompt-1", querySource: "agent:custom", costUsd: 0.08, input: 300, output: 30, cacheRead: 800, cacheCreate: 0 });

    const subagents: SubagentInfo[] = [makeSubagent("tu_a1", "code-architect")];
    await enrichment.enrichSubagentsFromOtel(sessionId, subagents);

    const agent = subagents[0];
    expect(agent.model).toBe("claude-haiku-4-5");
    expect(agent.durationMs).toBe(30_000);
    expect(agent.lastTimestamp).toBe("2026-05-25T10:00:30Z");
    // Solo invocation in the matched set → share = 1.0 → full cost.
    expect(agent.costUsd).toBeCloseTo(0.20, 4);
    expect(agent.inputTokens).toBe(800);
    expect(agent.outputTokens).toBe(80);
    expect(agent.cacheReadTokens).toBe(1800);
    expect(agent.cacheCreateTokens).toBe(200);
  });

  it("matches n-th JSONL dispatch of a type to n-th OTEL invocation of same type", async () => {
    const { enrichment, conn, mig } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "abc12345-0000-0000-0000-000000000002";
    // Three sequential code-architect invocations, each in its own prompt.id.
    insertSubagentCompleted(db, { ts: "2026-05-25T10:00:01Z", sessionId, promptId: "p1", agentType: "code-architect", durationMs: 1000, model: "m1", totalTokens: 100 });
    insertSubagentCompleted(db, { ts: "2026-05-25T10:00:02Z", sessionId, promptId: "p2", agentType: "code-architect", durationMs: 2000, model: "m2", totalTokens: 200 });
    insertSubagentCompleted(db, { ts: "2026-05-25T10:00:03Z", sessionId, promptId: "p3", agentType: "code-architect", durationMs: 3000, model: "m3", totalTokens: 300 });
    insertApiRequest(db, { ts: "2026-05-25T10:00:01Z", sessionId, promptId: "p1", querySource: "agent:custom", costUsd: 1.0, input: 10, output: 10, cacheRead: 0, cacheCreate: 0 });
    insertApiRequest(db, { ts: "2026-05-25T10:00:02Z", sessionId, promptId: "p2", querySource: "agent:custom", costUsd: 2.0, input: 20, output: 20, cacheRead: 0, cacheCreate: 0 });
    insertApiRequest(db, { ts: "2026-05-25T10:00:03Z", sessionId, promptId: "p3", querySource: "agent:custom", costUsd: 3.0, input: 30, output: 30, cacheRead: 0, cacheCreate: 0 });

    const subagents: SubagentInfo[] = [
      makeSubagent("tu_a1", "code-architect"),
      makeSubagent("tu_a2", "code-architect"),
      makeSubagent("tu_a3", "code-architect"),
    ];
    await enrichment.enrichSubagentsFromOtel(sessionId, subagents);

    expect(subagents[0].model).toBe("m1");
    expect(subagents[1].model).toBe("m2");
    expect(subagents[2].model).toBe("m3");
    expect(subagents[0].costUsd).toBeCloseTo(1.0, 4);
    expect(subagents[1].costUsd).toBeCloseTo(2.0, 4);
    expect(subagents[2].costUsd).toBeCloseTo(3.0, 4);
  });

  it("splits parallel-dispatch cost proportionally by total_tokens (PR #163 fix)", async () => {
    // The bug we shipped in T1.2 (PR #162): two agents sharing a
    // prompt.id each got the FULL prompt cost, not their share.
    // This test would have failed against pre-#163 code.
    const { enrichment, conn, mig } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "abc12345-0000-0000-0000-000000000003";
    insertSubagentCompleted(db, { ts: "2026-05-25T10:00:01Z", sessionId, promptId: "p-shared", agentType: "gsd-executor", durationMs: 1000, model: "claude-opus-4-7", totalTokens: 1000 });
    insertSubagentCompleted(db, { ts: "2026-05-25T10:00:02Z", sessionId, promptId: "p-shared", agentType: "gsd-verifier", durationMs: 2000, model: "claude-opus-4-7", totalTokens: 3000 });
    insertApiRequest(db, {
      ts: "2026-05-25T10:00:00Z",
      sessionId,
      promptId: "p-shared",
      querySource: "agent:custom",
      costUsd: 4.0,
      input: 100,
      output: 100,
      cacheRead: 0,
      cacheCreate: 0,
    });

    const subagents: SubagentInfo[] = [
      makeSubagent("tu_a1", "gsd-executor"),
      makeSubagent("tu_a2", "gsd-verifier"),
    ];
    await enrichment.enrichSubagentsFromOtel(sessionId, subagents);

    // gsd-executor: 1000/4000 = 25% → $1.00
    expect(subagents[0].costUsd).toBeCloseTo(1.0, 4);
    // gsd-verifier: 3000/4000 = 75% → $3.00
    expect(subagents[1].costUsd).toBeCloseTo(3.0, 4);
    // Token totals also split proportionally and round to integers.
    expect(subagents[0].inputTokens).toBe(25);
    expect(subagents[1].inputTokens).toBe(75);
    // Conservation: full prompt cost lands across the two invocations.
    expect(subagents[0].costUsd! + subagents[1].costUsd!).toBeCloseTo(4.0, 4);
  });

  it("leaves excess JSONL dispatches with undefined fields when OTEL has fewer invocations", async () => {
    const { enrichment, conn, mig } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "abc12345-0000-0000-0000-000000000004";
    insertSubagentCompleted(db, { ts: "2026-05-25T10:00:01Z", sessionId, promptId: "p1", agentType: "code-architect", durationMs: 1000, model: "m1", totalTokens: 100 });
    insertApiRequest(db, { ts: "2026-05-25T10:00:01Z", sessionId, promptId: "p1", querySource: "agent:custom", costUsd: 1.0, input: 10, output: 10, cacheRead: 0, cacheCreate: 0 });

    const subagents: SubagentInfo[] = [
      makeSubagent("tu_a1", "code-architect"),
      makeSubagent("tu_a2", "code-architect"),
      makeSubagent("tu_a3", "code-architect"),
    ];
    await enrichment.enrichSubagentsFromOtel(sessionId, subagents);

    expect(subagents[0].model).toBe("m1");
    expect(subagents[1].model).toBeUndefined();
    expect(subagents[2].model).toBeUndefined();
    expect(subagents[1].durationMs).toBeUndefined();
    expect(subagents[2].costUsd).toBeUndefined();
  });

  it("no-ops cleanly when no OTEL data exists for the session", async () => {
    const { enrichment, conn, mig } = await reloadModules();
    await mig.initDb();
    await conn.getDb();

    const subagents: SubagentInfo[] = [makeSubagent("tu_a1", "code-architect")];
    await enrichment.enrichSubagentsFromOtel("session-with-no-data", subagents);
    expect(subagents[0].model).toBeUndefined();
    expect(subagents[0].costUsd).toBeUndefined();
  });

  it("falls back to total_tokens when the prompt has no agent:* api_request rows", async () => {
    const { enrichment, conn, mig } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "abc12345-0000-0000-0000-000000000005";
    insertSubagentCompleted(db, { ts: "2026-05-25T10:00:01Z", sessionId, promptId: "lonely", agentType: "code-architect", durationMs: 5000, model: "m1", totalTokens: 9999 });
    // No api_request rows at all for this prompt — common when the
    // session's OTEL stream is partial.

    const subagents: SubagentInfo[] = [makeSubagent("tu_a1", "code-architect")];
    await enrichment.enrichSubagentsFromOtel(sessionId, subagents);

    expect(subagents[0].model).toBe("m1");
    expect(subagents[0].durationMs).toBe(5000);
    expect(subagents[0].totalTokens).toBe(9999);
    expect(subagents[0].inputTokens).toBeUndefined();
    expect(subagents[0].outputTokens).toBeUndefined();
    expect(subagents[0].costUsd).toBeUndefined();
  });

  it("excludes repl_main_thread cost from the matched set", async () => {
    const { enrichment, conn, mig } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "abc12345-0000-0000-0000-000000000006";
    insertSubagentCompleted(db, { ts: "2026-05-25T10:00:30Z", sessionId, promptId: "p-with-main", agentType: "code-architect", durationMs: 1000, model: "m1", totalTokens: 1000 });
    insertApiRequest(db, { ts: "2026-05-25T10:00:00Z", sessionId, promptId: "p-with-main", querySource: "repl_main_thread", costUsd: 99.0, input: 99999, output: 99999, cacheRead: 0, cacheCreate: 0 });
    insertApiRequest(db, { ts: "2026-05-25T10:00:10Z", sessionId, promptId: "p-with-main", querySource: "agent:custom", costUsd: 0.5, input: 100, output: 100, cacheRead: 0, cacheCreate: 0 });

    const subagents: SubagentInfo[] = [makeSubagent("tu_a1", "code-architect")];
    await enrichment.enrichSubagentsFromOtel(sessionId, subagents);

    // Only the $0.50 agent:custom cost is attributable; the $99 main-
    // thread cost is dropped from the subagent's share.
    expect(subagents[0].costUsd).toBeCloseTo(0.5, 4);
    expect(subagents[0].inputTokens).toBe(100);
  });
});
