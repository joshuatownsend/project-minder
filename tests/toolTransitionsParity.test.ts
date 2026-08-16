/**
 * Backend parity for `toolTransitions` / `toolSelfLoops` (#450).
 *
 * `usageFromDb.ts` returned `[]` for both until now, so the Tool Execution
 * Flow chart never rendered on the default backend — 99,053 turns over 90 days
 * produced zero transitions on a real index.
 *
 * The DB path deliberately reuses `computeToolTransitions` rather than
 * expressing the pairing in SQL, so this test's job is to prove the two
 * backends are fed *equivalent input*: same fixture, same numbers out. That is
 * the failure W5 found in `byCategory.oneShotRate`, where both backends
 * returned a valid shape and quietly disagreed about what it meant.
 *
 * The fixture exercises every branch of the definition:
 *   - consecutive calls WITHIN one turn
 *   - last tool of a turn to first tool of the NEXT turn
 *   - self-loops, both intra-turn and across a turn boundary
 *   - a tool-less turn, which must NOT break the chain
 *   - a session boundary, which MUST break it
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({ prefix: "pm-tooltrans-parity-" });
let tmpHome: string;

beforeEach(() => {
  tmpHome = state.tmpHome();
});

async function writeJsonl(filePath: string, entries: object[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** An assistant turn whose message carries `tools` in call order. */
function assistantWithTools(ts: string, tools: string[]) {
  return {
    type: "assistant",
    timestamp: ts,
    message: {
      model: "claude-sonnet-4-5",
      content: [
        { type: "text", text: "working" },
        ...tools.map((name, i) => ({
          type: "tool_use",
          id: `tu-${ts}-${i}`,
          name,
          input: {},
        })),
      ],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

/** An assistant turn with prose only — the chain must survive it. */
function assistantNoTools(ts: string) {
  return {
    type: "assistant",
    timestamp: ts,
    message: {
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "thinking out loud" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

function userTurn(ts: string, text: string) {
  return { type: "user", timestamp: ts, message: { content: [{ type: "text", text }] } };
}

async function reload() {
  await state.reload();
  return {
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
    ingest: await import("@/lib/db/ingest"),
    fromDb: await import("@/lib/data/usageFromDb"),
    parser: await import("@/lib/usage/parser"),
    toolTransitions: await import("@/lib/usage/toolTransitions"),
  };
}

describe.skipIf(!driverAvailable)("toolTransitions backend parity (#450)", () => {
  async function setup() {
    const reloaded = await reload();
    await reloaded.mig.initDb();
    const projectsDir = path.join(tmpHome, ".claude", "projects");

    // Session A: Read→Edit inside one turn, Edit→Edit across the boundary
    // (self-loop), then a tool-less turn, then Bash — so Edit→Bash must still
    // be counted across the gap.
    await writeJsonl(path.join(projectsDir, "C--dev-app", "flow-a.jsonl"), [
      userTurn("2026-05-01T10:00:00Z", "go"),
      assistantWithTools("2026-05-01T10:00:01Z", ["Read", "Edit"]),
      assistantWithTools("2026-05-01T10:00:02Z", ["Edit", "Grep"]),
      assistantNoTools("2026-05-01T10:00:03Z"),
      assistantWithTools("2026-05-01T10:00:04Z", ["Bash"]),
    ]);

    // Session B: a different chain, and its first tool must NOT continue
    // session A's — the session boundary has to break the sequence.
    await writeJsonl(path.join(projectsDir, "C--dev-app", "flow-b.jsonl"), [
      userTurn("2026-05-01T11:00:00Z", "go"),
      assistantWithTools("2026-05-01T11:00:01Z", ["Glob", "Glob", "Read"]),
    ]);

    return { ...reloaded, projectsDir };
  }

  it("produces identical transitions and self-loops on both backends", async () => {
    const { conn, ingest, fromDb, parser, toolTransitions, projectsDir } = await setup();
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    // (A) DB backend — through the real report builder, so the wiring at the
    // call site is covered too, not just the query in isolation.
    const dbReport = fromDb.loadUsageReportFromSql(db, "all");

    // (B) File backend — the same input the aggregator feeds it.
    const bySession = await parser.parseAllSessions();
    const assistantTurns = [...bySession.values()]
      .flat()
      .filter((t) => t.role === "assistant" && !t.isSidechain);
    const fileFlow = toolTransitions.computeToolTransitions(assistantTurns);

    // Precondition: a fixture that produced nothing would make the equality
    // below vacuously true — exactly the shape of the bug being fixed.
    expect(fileFlow.transitions.length).toBeGreaterThan(0);
    expect(fileFlow.selfLoops.length).toBeGreaterThan(0);

    const norm = <T,>(xs: readonly T[]): T[] =>
      [...xs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    expect(norm(dbReport.toolTransitions)).toEqual(norm(fileFlow.transitions));
    expect(norm(dbReport.toolSelfLoops)).toEqual(norm(fileFlow.selfLoops));
    conn.closeDb();
  });

  it("counts the specific edges the fixture was built to exercise", async () => {
    // Parity alone can be satisfied by two backends that are wrong in the same
    // way — both read from the same `computeToolTransitions`, so a shared
    // misreading of the INPUT would agree with itself. These assertions pin
    // the actual expected numbers.
    const { conn, ingest, fromDb, projectsDir } = await setup();
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const { toolTransitions: trans, toolSelfLoops: loops } = fromDb.loadUsageReportFromSql(db, "all");
    const t = (from: string, to: string) =>
      trans.find((x) => x.from === from && x.to === to)?.count ?? 0;
    const loop = (tool: string) => loops.find((x) => x.tool === tool)?.count ?? 0;

    expect(t("Read", "Edit")).toBe(1); // intra-turn
    expect(t("Edit", "Grep")).toBe(1); // intra-turn, second turn
    expect(t("Grep", "Bash")).toBe(1); // ACROSS the tool-less turn
    expect(loop("Edit")).toBe(1); // inter-turn self-loop
    expect(loop("Glob")).toBe(1); // intra-turn self-loop, session B
    expect(t("Glob", "Read")).toBe(1); // session B

    // The session boundary must break the chain: session A ends on Bash and
    // session B opens on Glob, so this pair must not exist.
    expect(t("Bash", "Glob")).toBe(0);
    conn.closeDb();
  });

  it("returns empty output rather than throwing when nothing matches the filter", async () => {
    const { conn, ingest, fromDb, projectsDir } = await setup();
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const report = fromDb.loadUsageReportFromSql(db, "all", "no-such-project");
    expect(report.toolTransitions).toEqual([]);
    expect(report.toolSelfLoops).toEqual([]);
    conn.closeDb();
  });
});
