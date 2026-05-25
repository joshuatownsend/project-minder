import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Tests for `computeAgentCostFromFiles` (back-compat name) and the
// underlying `computeAgentCostInvocationsFromOtel` it now delegates
// to. Replaces the legacy JSONL-walk tests — the parentToolUseID
// schema went away in Claude Code ~v2.1.150, so the old fixtures
// exercised dead code.
//
// The OTEL setup is identical to `tests/subagentMetrics.test.ts`:
// mkdtemp HOME → MINDER_USE_DB=1 → init the schema → INSERT fixture
// rows → reload modules so `getDb()` opens against the temp DB.

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
  delete (globalThis as { __agentCostCache?: unknown }).__agentCostCache;
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return {
    agentCost: await import("@/lib/usage/agentCost"),
    fromOtel: await import("@/lib/usage/agentCostFromOtel"),
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
  };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-agent-cost-otel-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
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

function insertSubagentCompleted(
  db: import("better-sqlite3").Database,
  args: {
    ts: string;
    sessionId: string;
    promptId: string;
    agentType: string;
    totalTokens: number;
    durationMs?: number;
    model?: string;
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
      "duration_ms": String(args.durationMs ?? 1000),
      "model": args.model ?? "claude-opus-4-7",
      "total_tokens": String(args.totalTokens),
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
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreate?: number;
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
      "input_tokens": String(args.input ?? 0),
      "output_tokens": String(args.output ?? 0),
      "cache_read_tokens": String(args.cacheRead ?? 0),
      "cache_creation_tokens": String(args.cacheCreate ?? 0),
    },
  }));
}

describe.skipIf(!driverAvailable)("computeAgentCostFromFiles (OTEL-backed)", () => {
  it("returns empty map when no OTEL events exist", async () => {
    const { agentCost, mig } = await reloadModules();
    await mig.initDb();

    const result = await agentCost.computeAgentCostFromFiles();
    expect(result.size).toBe(0);
  });

  it("attributes a single-invocation prompt's full agent:custom cost", async () => {
    const { agentCost, mig, conn } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "11111111-1111-1111-1111-111111111111";
    const promptId = "p-solo";
    insertSubagentCompleted(db, {
      ts: "2026-05-25T10:00:30Z",
      sessionId,
      promptId,
      agentType: "code-architect",
      totalTokens: 5000,
    });
    insertApiRequest(db, {
      ts: "2026-05-25T10:00:10Z",
      sessionId,
      promptId,
      querySource: "agent:custom",
      costUsd: 0.5,
      input: 100,
      output: 200,
    });

    const result = await agentCost.computeAgentCostFromFiles();
    const entry = result.get("code-architect")!;
    expect(entry).toBeDefined();
    expect(entry.costUsd).toBeCloseTo(0.5, 4);
    expect(entry.inputTokens).toBe(100);
    expect(entry.outputTokens).toBe(200);
  });

  it("splits 6× same-type parallel agents proportionally by total_tokens", async () => {
    // Empirical fixture from PR #163 probe: 6× general-purpose in one
    // prompt.id share $7.35 of agent:builtin:general-purpose cost.
    // The matched-set rule should give each its share, NOT the full
    // $7.35 (which was the T1.2 bug).
    const { agentCost, mig, conn } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "22222222-2222-2222-2222-222222222222";
    const promptId = "p-fanout-builtin";
    const tokens = [91938, 112412, 86267, 152133, 156148, 105519];
    for (let i = 0; i < tokens.length; i++) {
      insertSubagentCompleted(db, {
        ts: `2026-05-25T10:0${i}:30Z`,
        sessionId,
        promptId,
        agentType: "general-purpose",
        totalTokens: tokens[i],
      });
    }
    insertApiRequest(db, {
      ts: "2026-05-25T10:00:05Z",
      sessionId,
      promptId,
      querySource: "agent:builtin:general-purpose",
      costUsd: 7.3543,
      input: 60000,
      output: 12000,
    });

    const result = await agentCost.computeAgentCostFromFiles();
    const entry = result.get("general-purpose")!;
    expect(entry).toBeDefined();
    // All 6 invocations collapse back to the same total when summed
    // — no over- or under-counting.
    expect(entry.costUsd).toBeCloseTo(7.3543, 3);
    expect(entry.inputTokens).toBe(60000);
    expect(entry.outputTokens).toBe(12000);
  });

  it("splits parallel mixed-type agents by total_tokens within agent:custom", async () => {
    // Real-world fixture: gsd-executor (48662 tok) + gsd-verifier
    // (51417 tok) share one prompt.id; agent:custom cost should
    // distribute by token share, not full-to-each.
    const { agentCost, mig, conn } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "33333333-3333-3333-3333-333333333333";
    const promptId = "p-fanout-mixed";
    insertSubagentCompleted(db, {
      ts: "2026-05-25T13:13:55Z",
      sessionId,
      promptId,
      agentType: "gsd-executor",
      totalTokens: 48662,
    });
    insertSubagentCompleted(db, {
      ts: "2026-05-25T13:18:40Z",
      sessionId,
      promptId,
      agentType: "gsd-verifier",
      totalTokens: 51417,
    });
    insertApiRequest(db, {
      ts: "2026-05-25T13:10:00Z",
      sessionId,
      promptId,
      querySource: "agent:custom",
      costUsd: 1.5383,
      input: 2798,
      output: 17222,
    });

    const result = await agentCost.computeAgentCostFromFiles();
    const total = 48662 + 51417;
    const exec = result.get("gsd-executor")!;
    const verifier = result.get("gsd-verifier")!;
    expect(exec.costUsd).toBeCloseTo(1.5383 * (48662 / total), 4);
    expect(verifier.costUsd).toBeCloseTo(1.5383 * (51417 / total), 4);
    // Round-trip: distribution conserves total cost.
    expect(exec.costUsd + verifier.costUsd).toBeCloseTo(1.5383, 4);
  });

  it("excludes repl_main_thread cost from agent attribution", async () => {
    const { agentCost, mig, conn } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "44444444-4444-4444-4444-444444444444";
    const promptId = "p-main-and-agent";
    insertSubagentCompleted(db, {
      ts: "2026-05-25T10:00:30Z",
      sessionId,
      promptId,
      agentType: "code-architect",
      totalTokens: 1000,
    });
    insertApiRequest(db, {
      ts: "2026-05-25T10:00:05Z",
      sessionId,
      promptId,
      querySource: "repl_main_thread",
      costUsd: 10.0,
      input: 99999,
      output: 99999,
    });
    insertApiRequest(db, {
      ts: "2026-05-25T10:00:10Z",
      sessionId,
      promptId,
      querySource: "agent:custom",
      costUsd: 0.25,
      input: 100,
      output: 100,
    });

    const result = await agentCost.computeAgentCostFromFiles();
    const entry = result.get("code-architect")!;
    // Only the $0.25 from agent:custom should land — the $10
    // repl_main_thread cost stays unattributed.
    expect(entry.costUsd).toBeCloseTo(0.25, 4);
    expect(entry.inputTokens).toBe(100);
    expect(entry.outputTokens).toBe(100);
  });

  it("does not attribute agent:custom cost to a builtin invocation in the same prompt", async () => {
    // Defensive: even though no co-mingled prompts appear in the live
    // DB probe, the matched-set rule must guarantee that
    // `agent:custom` cost only flows to non-builtin invocations.
    const { agentCost, mig, conn } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "55555555-5555-5555-5555-555555555555";
    const promptId = "p-comingle";
    insertSubagentCompleted(db, {
      ts: "2026-05-25T10:00:30Z",
      sessionId,
      promptId,
      agentType: "general-purpose",
      totalTokens: 1000,
    });
    insertSubagentCompleted(db, {
      ts: "2026-05-25T10:00:31Z",
      sessionId,
      promptId,
      agentType: "gsd-planner",
      totalTokens: 1000,
    });
    insertApiRequest(db, {
      ts: "2026-05-25T10:00:05Z",
      sessionId,
      promptId,
      querySource: "agent:builtin:general-purpose",
      costUsd: 1.0,
    });
    insertApiRequest(db, {
      ts: "2026-05-25T10:00:10Z",
      sessionId,
      promptId,
      querySource: "agent:custom",
      costUsd: 2.0,
    });

    const result = await agentCost.computeAgentCostFromFiles();
    expect(result.get("general-purpose")!.costUsd).toBeCloseTo(1.0, 4);
    expect(result.get("gsd-planner")!.costUsd).toBeCloseTo(2.0, 4);
  });

  it("omits invocations whose prompt had no agent:* api_request rows", async () => {
    const { agentCost, mig, conn } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "66666666-6666-6666-6666-666666666666";
    insertSubagentCompleted(db, {
      ts: "2026-05-25T10:00:30Z",
      sessionId,
      promptId: "p-no-api",
      agentType: "code-architect",
      totalTokens: 5000,
    });
    // No api_request rows at all.

    const result = await agentCost.computeAgentCostFromFiles();
    // No cost attribution → not present in the back-compat Map shape
    // (the wrapper drops zero-cost entries to mirror legacy behavior).
    expect(result.has("code-architect")).toBe(false);
  });

  it("caches the result for 2 minutes", async () => {
    const { agentCost, mig, conn } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "77777777-7777-7777-7777-777777777777";
    insertSubagentCompleted(db, {
      ts: "2026-05-25T10:00:30Z",
      sessionId,
      promptId: "p-cache",
      agentType: "code-architect",
      totalTokens: 5000,
    });
    insertApiRequest(db, {
      ts: "2026-05-25T10:00:10Z",
      sessionId,
      promptId: "p-cache",
      querySource: "agent:custom",
      costUsd: 0.5,
    });

    const first = await agentCost.computeAgentCostFromFiles();
    expect(first.size).toBe(1);

    // Insert another row; cache should hide it for 2 min.
    insertSubagentCompleted(db, {
      ts: "2026-05-25T10:01:00Z",
      sessionId,
      promptId: "p-cache-2",
      agentType: "second-agent",
      totalTokens: 5000,
    });
    insertApiRequest(db, {
      ts: "2026-05-25T10:01:10Z",
      sessionId,
      promptId: "p-cache-2",
      querySource: "agent:custom",
      costUsd: 0.7,
    });

    const second = await agentCost.computeAgentCostFromFiles();
    expect(second.has("second-agent")).toBe(false);
    expect(second).toBe(first); // same Map reference
  });
});

describe.skipIf(!driverAvailable)("computeAgentCostInvocationsFromOtel", () => {
  it("sessionId filter restricts to a single session", async () => {
    const { fromOtel, mig, conn } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    insertSubagentCompleted(db, {
      ts: "2026-05-25T10:00:30Z",
      sessionId: "session-a",
      promptId: "p-a",
      agentType: "code-architect",
      totalTokens: 1000,
    });
    insertApiRequest(db, {
      ts: "2026-05-25T10:00:10Z",
      sessionId: "session-a",
      promptId: "p-a",
      querySource: "agent:custom",
      costUsd: 0.1,
    });
    insertSubagentCompleted(db, {
      ts: "2026-05-25T10:00:30Z",
      sessionId: "session-b",
      promptId: "p-b",
      agentType: "code-architect",
      totalTokens: 1000,
    });
    insertApiRequest(db, {
      ts: "2026-05-25T10:00:10Z",
      sessionId: "session-b",
      promptId: "p-b",
      querySource: "agent:custom",
      costUsd: 0.2,
    });

    const sessionA = await fromOtel.computeAgentCostInvocationsFromOtel({
      sessionId: "session-a",
    });
    expect(sessionA).toHaveLength(1);
    expect(sessionA[0].sessionId).toBe("session-a");
    expect(sessionA[0].costUsd).toBeCloseTo(0.1, 4);

    const all = await fromOtel.computeAgentCostInvocationsFromOtel();
    expect(all).toHaveLength(2);
  });
});
