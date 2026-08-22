/**
 * A4 — causal cost attribution for skills and MCP servers.
 *
 * Two things carry the weight here.
 *
 * **Dual-backend parity.** `bySkillCost` / `byMcpCost` are assembled twice, by
 * `aggregator.ts` over parsed turns and by `GROUP BY` in `usageFromDb.ts`.
 * Every A-wave slice so far has shipped at least one divergence between those
 * two, and each was invisible in normal use because an install only runs one.
 *
 * **The all-or-nothing fallback.** Explicit attribution and the legacy
 * inference differ by ~11x (MCP) and ~373x (skills) on real data, so a list
 * that mixed them would be meaningless. The contract is that a list is wholly
 * explicit or wholly inferred, and says which.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import {
  mcpServerKey,
  mcpDisplayName,
  isAttributed,
} from "@/lib/usage/attribution";
import type { SkillCost, McpServerCost } from "@/lib/usage/types";
import { installIsolatedState } from "./_helpers/isolatedState";

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

describe("mcpServerKey", () => {
  it("folds the explicit id onto the form recovered from a tool name", () => {
    // `plugin:playwright:playwright` is what the MCP config calls it;
    // `mcp__plugin_playwright_playwright__browser_click` is what the tool name
    // encodes, and the inference recovers the middle segment verbatim.
    expect(mcpServerKey("plugin:playwright:playwright")).toBe("plugin_playwright_playwright");
  });

  it("folds dots and spaces too, not just colons", () => {
    // Real server id from the corpus. A colon-only replacement would leave
    // this unmatched and list the server twice.
    expect(mcpServerKey("claude.ai Vercel")).toBe("claude_ai_Vercel");
  });

  it("preserves hyphens, which survive the tool-name encoding", () => {
    expect(mcpServerKey("claude-in-chrome")).toBe("claude-in-chrome");
    expect(mcpServerKey("plugin:context-mode:context-mode")).toBe(
      "plugin_context-mode_context-mode"
    );
  });

  it("is idempotent, so folding an already-folded name is safe", () => {
    const once = mcpServerKey("plugin:github:github");
    expect(mcpServerKey(once)).toBe(once);
  });
});

describe("mcpDisplayName", () => {
  it("prefers the explicit id — the name a user recognizes", () => {
    expect(mcpDisplayName("plugin:playwright:playwright", "plugin_playwright_playwright"))
      .toBe("plugin:playwright:playwright");
  });

  it("falls back to the inferred name when there is no explicit one", () => {
    expect(mcpDisplayName(null, "plugin_playwright_playwright"))
      .toBe("plugin_playwright_playwright");
    expect(mcpDisplayName("   ", "github")).toBe("github");
  });
});

describe("isAttributed", () => {
  it("rejects empty string as well as null/undefined", () => {
    // The empty-string gap shipped twice before (effort, entrypoint): the TS
    // side bucketed "" while SQL only COALESCEd NULL.
    expect(isAttributed("")).toBe(false);
    expect(isAttributed(null)).toBe(false);
    expect(isAttributed(undefined)).toBe(false);
    expect(isAttributed("pr-resolve")).toBe(true);
  });
});

// ── dual-backend parity ────────────────────────────────────────────────────

const state = installIsolatedState({ prefix: "pm-a4-", preserveEnv: ["MINDER_USE_DB"] });

/** Mirror of the helper's temp home, so fixture paths below read unchanged. */
let tmpHome: string;

beforeEach(() => {
  tmpHome = state.tmpHome();
});

interface Attr {
  attributionSkill?: string;
  attributionMcpServer?: string;
  attributionMcpTool?: string;
}

/** Attribution rides the TOP LEVEL of an assistant entry, not `message`. */
function assistant(ts: string, attr: Attr = {}, content?: unknown[]) {
  return {
    type: "assistant",
    timestamp: ts,
    ...attr,
    message: {
      model: "claude-opus-5",
      role: "assistant",
      content: content ?? [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

function userTurn(ts: string, text: string) {
  return { type: "user", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } };
}

function toolResult(ts: string, id: string, text: string) {
  return {
    type: "user", timestamp: ts,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
  };
}

/**
 * One session with:
 *   - two turns attributed to `pr-resolve`, one of which anchors a task that
 *     passes verification first time
 *   - one turn attributed to `simplify`
 *   - MCP attribution under BOTH spellings of the same server, which must fold
 *     into a single row rather than listing twice
 */
async function writeExplicitFixture(): Promise<void> {
  const dir = path.join(tmpHome, ".claude", "projects", "C--dev-x");
  await fs.mkdir(dir, { recursive: true });
  const edit = (id: string) => ({
    type: "tool_use", id, name: "Edit",
    input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
  });
  const bash = (id: string) => ({
    type: "tool_use", id, name: "Bash", input: { command: "pnpm test" },
  });

  const entries = [
    userTurn("2026-08-01T10:00:00Z", "fix it"),
    // pr-resolve edit → verify → pass  ⇒ one_shot, anchored on the edit turn
    assistant("2026-08-01T10:00:01Z", { attributionSkill: "pr-resolve" }, [edit("tu_1")]),
    toolResult("2026-08-01T10:00:02Z", "tu_1", "edited"),
    assistant("2026-08-01T10:00:03Z", { attributionSkill: "pr-resolve" }, [bash("tu_2")]),
    toolResult("2026-08-01T10:00:04Z", "tu_2", "Test Files 3 passed\nTests 9 passed"),
    assistant("2026-08-01T10:00:05Z", { attributionSkill: "simplify" }),
    // Same server, both spellings — must fold to one row.
    assistant("2026-08-01T10:00:06Z", {
      attributionMcpServer: "plugin:playwright:playwright",
      attributionMcpTool: "browser_click",
    }),
    assistant("2026-08-01T10:00:07Z", {
      attributionMcpServer: "plugin_playwright_playwright",
      attributionMcpTool: "browser_take_screenshot",
    }),
  ];
  await fs.writeFile(
    path.join(dir, "a4-session.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
}

/** No explicit attribution anywhere — only an inferable MCP tool call. */
async function writeInferredOnlyFixture(): Promise<void> {
  const dir = path.join(tmpHome, ".claude", "projects", "C--dev-y");
  await fs.mkdir(dir, { recursive: true });
  const entries = [
    userTurn("2026-08-02T10:00:00Z", "browse"),
    assistant("2026-08-02T10:00:01Z", {}, [
      { type: "tool_use", id: "tu_9", name: "mcp__plugin_playwright_playwright__browser_click", input: {} },
    ]),
  ];
  await fs.writeFile(
    path.join(dir, "a4-inferred.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
}

function bySkill(rows: SkillCost[]): Record<string, SkillCost> {
  return Object.fromEntries(rows.map((r) => [r.skill, r]));
}

describe.skipIf(!driverAvailable)("A4 attribution — file-parse vs SQLite parity", () => {
  async function reportFrom(useDb: boolean) {
  await state.reload();
    process.env.MINDER_USE_DB = useDb ? "1" : "0";

    if (useDb) {
      const mig = await import("@/lib/db/migrations");
      const init = await mig.initDb();
      expect(init.error).toBeNull();
      const conn = await import("@/lib/db/connection");
      const db = await conn.getDb();
      expect(db).not.toBeNull();
      const ingest = await import("@/lib/db/ingest");
      await ingest.reconcileAllSessions(db!, {
        projectsDir: path.join(tmpHome, ".claude", "projects"),
        recordRun: "reconcile",
      });
    }
    const data = await import("@/lib/data");
    const { report, meta } = await data.getUsage("all", undefined);
    expect(meta.backend).toBe(useDb ? "db" : "file");
    return report;
  }

  it("produces identical skill attribution on both backends", async () => {
    await writeExplicitFixture();
    const f = await reportFrom(false);
    const d = await reportFrom(true);

    expect(d.bySkillCost.map((r) => r.skill)).toEqual(f.bySkillCost.map((r) => r.skill));
    for (const key of f.bySkillCost.map((r) => r.skill)) {
      const a = bySkill(f.bySkillCost)[key];
      const b = bySkill(d.bySkillCost)[key];
      expect({ key, turns: b.turns, tokens: b.tokens, method: b.method,
               verifiedTasks: b.verifiedTasks, oneShotTasks: b.oneShotTasks })
        .toEqual({ key, turns: a.turns, tokens: a.tokens, method: a.method,
                   verifiedTasks: a.verifiedTasks, oneShotTasks: a.oneShotTasks });
    }
  });

  it("produces identical MCP attribution on both backends", async () => {
    await writeExplicitFixture();
    const f = await reportFrom(false);
    const d = await reportFrom(true);
    expect(d.byMcpCost.map((r) => r.key)).toEqual(f.byMcpCost.map((r) => r.key));
    for (let i = 0; i < f.byMcpCost.length; i++) {
      expect({ ...pickMcp(d.byMcpCost[i]) }).toEqual({ ...pickMcp(f.byMcpCost[i]) });
    }
    function pickMcp(r: McpServerCost) {
      return { key: r.key, turns: r.turns, tokens: r.tokens, method: r.method };
    }
  });

  it.each([true, false])(
    "folds both spellings of one server into a single row (useDb=%s)",
    async (useDb) => {
      await writeExplicitFixture();
      const r = await reportFrom(useDb);
      const playwright = r.byMcpCost.filter((m) => m.key === "plugin_playwright_playwright");
      // Two turns, two spellings, ONE row — otherwise the same server appears
      // twice under names a user cannot tell apart.
      expect(playwright).toHaveLength(1);
      expect(playwright[0].turns).toBe(2);
    }
  );

  it.each([true, false])(
    "marks explicit attribution as such and never mixes methods (useDb=%s)",
    async (useDb) => {
      await writeExplicitFixture();
      const r = await reportFrom(useDb);
      expect(r.bySkillCost.length).toBeGreaterThan(0);
      // A list is wholly one method or the other — explicit and inferred
      // figures differ by orders of magnitude, so a mixed series is worse
      // than either alone.
      expect(new Set(r.bySkillCost.map((s) => s.method))).toEqual(new Set(["explicit"]));
      expect(new Set(r.byMcpCost.map((s) => s.method))).toEqual(new Set(["explicit"]));
    }
  );

  it.each([true, false])(
    "falls back to inference only when nothing is explicitly attributed (useDb=%s)",
    async (useDb) => {
      await writeInferredOnlyFixture();
      const r = await reportFrom(useDb);
      expect(r.byMcpCost).toHaveLength(1);
      expect(r.byMcpCost[0].method).toBe("inferred");
      expect(r.byMcpCost[0].key).toBe("plugin_playwright_playwright");
    }
  );

  it.each([true, false])(
    "splits a server's spend per tool, folded across both spellings (useDb=%s)",
    async (useDb) => {
      await writeExplicitFixture();
      const r = await reportFrom(useDb);
      const pw = r.byMcpCost.find((m) => m.key === "plugin_playwright_playwright");
      expect(pw).toBeDefined();
      // The two turns used different tools AND different spellings of the
      // server. Both tools must appear under the one folded server row —
      // grouping on the raw name would split them across two rows.
      expect(pw!.tools?.map((t) => t.tool).sort()).toEqual([
        "browser_click", "browser_take_screenshot",
      ]);
      expect(pw!.tools?.reduce((s, t) => s + t.turns, 0)).toBe(pw!.turns);
    }
  );

  it("omits the per-tool split on the inferred path rather than fabricating one", async () => {
    await writeInferredOnlyFixture();
    // `attribution_mcp_tool` is Claude Code's own field with no inferred
    // counterpart worth trusting at this granularity, so an inferred list
    // carries no tools at all — better than a plausible-looking guess.
    for (const useDb of [false, true]) {
      const r = await reportFrom(useDb);
      expect(r.byMcpCost[0].method).toBe("inferred");
      expect(r.byMcpCost[0].tools).toBeUndefined();
    }
  });

  it.each([true, false])(
    "crosses task outcomes with the skill that caused the work (useDb=%s)",
    async (useDb) => {
      await writeExplicitFixture();
      const rows = bySkill((await reportFrom(useDb)).bySkillCost);

      // pr-resolve anchored one verified task and it passed first time. The
      // anchor is the EDIT turn, so this is "work started under pr-resolve",
      // not "the turn that happened to run the test".
      expect(rows["pr-resolve"].verifiedTasks).toBe(1);
      expect(rows["pr-resolve"].oneShotTasks).toBe(1);
      expect(rows["pr-resolve"].oneShotRate).toBe(1);

      // simplify anchored none — undefined, never 0, so "not measured" stays
      // distinguishable from "failed every time".
      expect(rows["simplify"].verifiedTasks).toBe(0);
      expect(rows["simplify"].oneShotRate).toBeUndefined();
    }
  );
});

describe.skipIf(!driverAvailable)("skill attribution on the /skills catalog", () => {
  /**
   * @param expectDbBackend assert the DB leg really ran. Only meaningful when
   *   the fixture HAS data for it: with a genuinely empty corpus the facade
   *   falls back to file-parse by design ("indexer warming up"), so demanding
   *   `db` there would be asserting against intended behaviour.
   */
  async function skillUsageFrom(useDb: boolean, expectDbBackend = true) {
    await state.reload();
    process.env.MINDER_USE_DB = useDb ? "1" : "0";

    if (useDb) {
      const mig = await import("@/lib/db/migrations");
      expect((await mig.initDb()).error).toBeNull();
      const conn = await import("@/lib/db/connection");
      const db = await conn.getDb();
      const ingest = await import("@/lib/db/ingest");
      await ingest.reconcileAllSessions(db!, {
        projectsDir: path.join(tmpHome, ".claude", "projects"),
        recordRun: "reconcile",
      });
    }
    const data = await import("@/lib/data");
    const result = await data.getSkillUsage("all");
    // Load-bearing. The bug this suite caught was the DB path returning `[]`
    // and the facade silently falling back to file-parse — which produced the
    // right answer by the wrong route and would have hidden a dead DB query
    // forever. Assert the backend actually under test ran.
    if (!useDb || expectDbBackend) {
      expect(result.meta.backend).toBe(useDb ? "db" : "file");
    }
    return result;
  }

  it.each([true, false])(
    "reports attributed spend for a skill with no recorded invocation (useDb=%s)",
    async (useDb) => {
      await writeExplicitFixture();
      const { stats } = await skillUsageFrom(useDb);
      const pr = stats.find((s) => s.name === "pr-resolve");

      // The fixture never dispatches the Skill tool, so invocation counting
      // sees nothing. Attribution sees the two turns the skill caused — which
      // is the entire point of A4, and why a catalog showing only invocation
      // counts understates cost by orders of magnitude.
      expect(pr).toBeDefined();
      expect(pr!.invocations).toBe(0);
      expect(pr!.attributedTurns).toBe(2);
      expect(pr!.attributedCostUsd).toBeGreaterThan(0);
    }
  );

  it.each([true, false])(
    "leaves attribution undefined — not 0 — for an unattributed skill (useDb=%s)",
    async (useDb) => {
      await writeInferredOnlyFixture();
      // No skills at all here, so the DB legitimately returns nothing and the
      // facade falls back — the designed cold-indexer path, not a defect.
      const { stats } = await skillUsageFrom(useDb, false);
      // Nothing attributed anywhere in this fixture, so no skill should claim
      // a zero cost it never measured.
      for (const st of stats) {
        expect(st.attributedCostUsd).toBeUndefined();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// PR #382 review follow-ups. Three defects, two root causes.
//
//  1. JOIN MULTIPLICITY (Copilot + Codex P2). The inferred DB queries joined
//     `tool_uses` to `turns` and summed cost per joined row, so a turn making
//     N calls to one target was charged N times. `COUNT(DISTINCT ...)` kept the
//     turn count honest, which is exactly why it read as correct. The original
//     parity fixture had one call in one turn -- multiplicity of 1 -- so it
//     could never have caught this. These fixtures repeat the call.
//
//  2. SIDECHAIN SCOPE (Codex P2 x2). Attribution is turn-derived and the DB
//     stores sidechain turns, so explicit spend rightly includes them.
//     Inference is tool-derived and ingest writes no `tool_uses` for
//     sidechains, so inferred spend must exclude them or the two backends
//     disagree. The rule was broken in both the aggregator and the catalog.
//
//  3. V3 GATE (Codex P2). A4 turned the skills catalog into a `cost_usd`
//     reader without adding the readiness gate every other cost-backed read
//     already has.
// ---------------------------------------------------------------------------

/** One turn, repeating the SAME MCP server and the SAME skill twice. */
async function writeRepeatedCallsFixture(): Promise<void> {
  const dir = path.join(tmpHome, ".claude", "projects", "C--dev-rep");
  await fs.mkdir(dir, { recursive: true });
  const entries = [
    userTurn("2026-08-03T10:00:00Z", "go"),
    assistant("2026-08-03T10:00:01Z", {}, [
      { type: "tool_use", id: "r1", name: "mcp__plugin_playwright_playwright__browser_click", input: {} },
      { type: "tool_use", id: "r2", name: "mcp__plugin_playwright_playwright__browser_navigate", input: {} },
      { type: "tool_use", id: "r3", name: "Skill", input: { skill: "pr-resolve" } },
      { type: "tool_use", id: "r4", name: "Skill", input: { skill: "pr-resolve" } },
    ]),
  ];
  await fs.writeFile(
    path.join(dir, "a4-repeat.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
}

/** A subagent turn that dispatches a skill and calls an MCP server. */
async function writeSidechainFixture(): Promise<void> {
  const dir = path.join(tmpHome, ".claude", "projects", "C--dev-side");
  await fs.mkdir(dir, { recursive: true });
  const entries = [
    userTurn("2026-08-04T10:00:00Z", "delegate"),
    {
      ...assistant("2026-08-04T10:00:01Z", {}, [
        { type: "tool_use", id: "s1", name: "Skill", input: { skill: "pr-resolve" } },
        { type: "tool_use", id: "s2", name: "mcp__plugin_playwright_playwright__browser_click", input: {} },
      ]),
      isSidechain: true,
    },
  ];
  await fs.writeFile(
    path.join(dir, "a4-side.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
}

describe.skipIf(!driverAvailable)("A4 review follow-ups", () => {
  async function bootDb() {
    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = await conn.getDb();
    expect(db).not.toBeNull();
    const ingest = await import("@/lib/db/ingest");
    await ingest.reconcileAllSessions(db!, {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
      recordRun: "reconcile",
    });
    return db!;
  }

  async function usageFrom(useDb: boolean) {
    await state.reload();
    process.env.MINDER_USE_DB = useDb ? "1" : "0";
    if (useDb) await bootDb();
    const data = await import("@/lib/data");
    const { report, meta } = await data.getUsage("all", undefined);
    expect(meta.backend).toBe(useDb ? "db" : "file");
    return report;
  }

  it("charges a repeated MCP call once, not once per call", async () => {
    await writeRepeatedCallsFixture();
    const f = await usageFrom(false);
    const d = await usageFrom(true);

    const fRow = f.byMcpCost[0];
    const dRow = d.byMcpCost[0];
    expect(fRow?.method).toBe("inferred");
    // Non-vacuity: without a priced turn the equality below proves nothing.
    expect(fRow.cost).toBeGreaterThan(0);

    // One turn made both calls. Before the fix the DB reported turns=1 (the
    // DISTINCT held) with cost and tokens doubled.
    expect(dRow.turns).toBe(1);
    expect(fRow.turns).toBe(1);
    expect(dRow.cost).toBeCloseTo(fRow.cost, 10);
    expect(dRow.tokens).toBe(fRow.tokens);
  });

  it("charges a repeated skill dispatch once, not once per dispatch", async () => {
    await writeRepeatedCallsFixture();
    const f = await usageFrom(false);
    const d = await usageFrom(true);

    const fRow = bySkill(f.bySkillCost)["pr-resolve"];
    const dRow = bySkill(d.bySkillCost)["pr-resolve"];
    expect(fRow?.method).toBe("inferred");
    expect(fRow.cost).toBeGreaterThan(0);

    expect(dRow.turns).toBe(1);
    expect(fRow.turns).toBe(1);
    expect(dRow.cost).toBeCloseTo(fRow.cost, 10);
    expect(dRow.tokens).toBe(fRow.tokens);
  });

  it("keeps sidechain turns out of INFERRED spend on both backends", async () => {
    await writeSidechainFixture();
    const f = await usageFrom(false);
    const d = await usageFrom(true);

    // The only turn in this fixture is a subagent turn. Inference is
    // tool-derived and the DB has no tool_uses for it, so neither backend may
    // report spend -- previously the file backend alone did.
    expect(f.byMcpCost).toEqual([]);
    expect(f.bySkillCost).toEqual([]);
    expect(d.byMcpCost).toEqual([]);
    expect(d.bySkillCost).toEqual([]);
  });

  it("keeps sidechain dispatches out of catalog invocation counts", async () => {
    await writeSidechainFixture();

    async function catalogFrom(useDb: boolean) {
      await state.reload();
      process.env.MINDER_USE_DB = useDb ? "1" : "0";
      if (useDb) await bootDb();
      const data = await import("@/lib/data");
      return (await data.getSkillUsage("all")).stats;
    }

    const fileStats = await catalogFrom(false);
    const dbStats = await catalogFrom(true);

    // A subagent dispatching a skill must not inflate the catalog: ingest
    // records no tool_use for it, so counting it file-side made the number
    // depend on the backend.
    expect(fileStats.find((s) => s.name === "pr-resolve")?.invocations ?? 0).toBe(0);
    expect(dbStats.find((s) => s.name === "pr-resolve")?.invocations ?? 0).toBe(0);
  });

  it("falls back to file-parse while the v3 reconcile is still pending", async () => {
    await writeExplicitFixture();
    await state.reload();
    process.env.MINDER_USE_DB = "1";
    const db = await bootDb();

    // Mid-catch-up: attribution columns are populated but cost_usd is not.
    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('needs_reconcile_after_v3', '1')"
    ).run();

    const data = await import("@/lib/data");
    const result = await data.getSkillUsage("all");

    // Without the gate this returns the DB rows with every cost at $0 --
    // non-empty, so the empty-index fallback never fires, and the catalog
    // shows zeroes as though they were measured.
    expect(result.meta.backend).toBe("file");
    expect(result.stats.find((s) => s.name === "pr-resolve")?.attributedCostUsd)
      .toBeGreaterThan(0);
  });
});
