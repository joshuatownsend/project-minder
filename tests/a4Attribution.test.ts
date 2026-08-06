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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import {
  mcpServerKey,
  mcpDisplayName,
  isAttributed,
} from "@/lib/usage/attribution";
import type { SkillCost, McpServerCost } from "@/lib/usage/types";

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

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalUseDb: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalUseDb = process.env.MINDER_USE_DB;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-a4-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [k, v] of [
    ["HOME", originalHome],
    ["USERPROFILE", originalUserProfile],
    ["MINDER_USE_DB", originalUseDb],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
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
      attributionMcpTool: "browser_click",
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
    vi.resetModules();
    delete (globalThis as { __minderDb?: unknown }).__minderDb;
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
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
