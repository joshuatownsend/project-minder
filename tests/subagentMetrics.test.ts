import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import type { SubagentInfo } from "@/lib/types";

// Tests for `enrichSubagentsFromOtel` — populates per-subagent runtime
// metrics (cost, tokens, model, duration) on JSONL-derived SubagentInfo
// entries by querying the OTEL events table for `subagent_completed` +
// `api_request` rows linked by `prompt.id`.
//
// JSONL sidechain data went away in Claude Code ~v2.1.150 (probed
// 2026-05-25: 0/214 sessions had isSidechain assistants). This enrichment
// is the working replacement.

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
  args: { ts: string; sessionId: string; promptId: string; agentType: string; durationMs: number; model: string; totalTokens: number; totalToolUses: number },
): void {
  db.prepare(`
    INSERT INTO otel_events (event_name, ts, payload_json)
    VALUES ('subagent_completed', ?, ?)
  `).run(args.ts, JSON.stringify({
    attrs: {
      "session.id": args.sessionId,
      "prompt.id": args.promptId,
      "agent_type": args.agentType,
      "duration_ms": String(args.durationMs),
      "model": args.model,
      "total_tokens": String(args.totalTokens),
      "total_tool_uses": String(args.totalToolUses),
    },
  }));
}

function insertApiRequest(
  db: import("better-sqlite3").Database,
  args: { ts: string; sessionId: string; promptId: string; costUsd: number; input: number; output: number; cacheRead: number; cacheCreate: number },
): void {
  db.prepare(`
    INSERT INTO otel_events (event_name, ts, payload_json)
    VALUES ('api_request', ?, ?)
  `).run(args.ts, JSON.stringify({
    attrs: {
      "session.id": args.sessionId,
      "prompt.id": args.promptId,
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
      agentType: "Explore",
      durationMs: 30_000,
      model: "claude-haiku-4-5",
      totalTokens: 12_345,
      totalToolUses: 7,
    });
    insertApiRequest(db, { ts: "2026-05-25T10:00:05Z", sessionId, promptId: "prompt-1", costUsd: 0.12, input: 500, output: 50, cacheRead: 1000, cacheCreate: 200 });
    insertApiRequest(db, { ts: "2026-05-25T10:00:25Z", sessionId, promptId: "prompt-1", costUsd: 0.08, input: 300, output: 30, cacheRead: 800, cacheCreate: 0 });

    const subagents: SubagentInfo[] = [makeSubagent("tu_a1", "Explore")];
    await enrichment.enrichSubagentsFromOtel(sessionId, subagents);

    const agent = subagents[0];
    expect(agent.model).toBe("claude-haiku-4-5");
    expect(agent.durationMs).toBe(30_000);
    expect(agent.lastTimestamp).toBe("2026-05-25T10:00:30Z");
    // Cost + tokens summed across the two api_request rows.
    expect(agent.costUsd).toBeCloseTo(0.20, 4);
    expect(agent.inputTokens).toBe(800);
    expect(agent.outputTokens).toBe(80);
    expect(agent.cacheReadTokens).toBe(1800);
    expect(agent.cacheCreateTokens).toBe(200);
  });

  it("matches n-th JSONL dispatch of a type to n-th OTEL completion of same type", async () => {
    const { enrichment, conn, mig } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "abc12345-0000-0000-0000-000000000002";
    // Three Explore invocations in chronological order
    insertSubagentCompleted(db, { ts: "2026-05-25T10:00:01Z", sessionId, promptId: "p1", agentType: "Explore", durationMs: 1000, model: "m1", totalTokens: 100, totalToolUses: 1 });
    insertSubagentCompleted(db, { ts: "2026-05-25T10:00:02Z", sessionId, promptId: "p2", agentType: "Explore", durationMs: 2000, model: "m2", totalTokens: 200, totalToolUses: 2 });
    insertSubagentCompleted(db, { ts: "2026-05-25T10:00:03Z", sessionId, promptId: "p3", agentType: "Explore", durationMs: 3000, model: "m3", totalTokens: 300, totalToolUses: 3 });

    const subagents: SubagentInfo[] = [
      makeSubagent("tu_a1", "Explore"),
      makeSubagent("tu_a2", "Explore"),
      makeSubagent("tu_a3", "Explore"),
    ];
    await enrichment.enrichSubagentsFromOtel(sessionId, subagents);

    expect(subagents[0].model).toBe("m1");
    expect(subagents[1].model).toBe("m2");
    expect(subagents[2].model).toBe("m3");
    expect(subagents[0].durationMs).toBe(1000);
    expect(subagents[1].durationMs).toBe(2000);
    expect(subagents[2].durationMs).toBe(3000);
  });

  it("leaves excess JSONL dispatches with undefined fields when OTEL has fewer completions", async () => {
    const { enrichment, conn, mig } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "abc12345-0000-0000-0000-000000000003";
    insertSubagentCompleted(db, { ts: "2026-05-25T10:00:01Z", sessionId, promptId: "p1", agentType: "Explore", durationMs: 1000, model: "m1", totalTokens: 100, totalToolUses: 1 });

    // 3 JSONL dispatches but only 1 OTEL completion — extras stay unenriched.
    const subagents: SubagentInfo[] = [
      makeSubagent("tu_a1", "Explore"),
      makeSubagent("tu_a2", "Explore"),
      makeSubagent("tu_a3", "Explore"),
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

    const subagents: SubagentInfo[] = [makeSubagent("tu_a1", "Explore")];
    await enrichment.enrichSubagentsFromOtel("session-with-no-data", subagents);
    // Skeleton SubagentInfo unchanged.
    expect(subagents[0].model).toBeUndefined();
    expect(subagents[0].costUsd).toBeUndefined();
  });

  it("falls back to total_tokens when no api_request rollup is available", async () => {
    const { enrichment, conn, mig } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;

    const sessionId = "abc12345-0000-0000-0000-000000000004";
    insertSubagentCompleted(db, { ts: "2026-05-25T10:00:01Z", sessionId, promptId: "lonely", agentType: "Explore", durationMs: 5000, model: "m1", totalTokens: 9999, totalToolUses: 3 });
    // No api_request rows for prompt "lonely".

    const subagents: SubagentInfo[] = [makeSubagent("tu_a1", "Explore")];
    await enrichment.enrichSubagentsFromOtel(sessionId, subagents);

    expect(subagents[0].model).toBe("m1");
    expect(subagents[0].durationMs).toBe(5000);
    expect(subagents[0].inputTokens).toBe(9999);
    // Cost stays undefined — we can't reliably split I/O for pricing.
    expect(subagents[0].costUsd).toBeUndefined();
    expect(subagents[0].outputTokens).toBeUndefined();
  });
});
