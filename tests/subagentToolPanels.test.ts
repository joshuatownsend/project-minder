import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";

/**
 * #511 — a delegated agent's TOOLS and FILE OPERATIONS panels.
 *
 * #487 gave a nested subagent transcript a real timeline; its tool and file
 * panels stayed empty, because both read `tool_uses WHERE session_id = ?` and a
 * subagent's calls are not there — #395 deliberately put them in
 * `sidechain_tool_uses`.
 *
 * #511 listed three ways out and this is the first: widen that table to carry
 * what a timeline needs and have the detail loader read it for a session whose
 * path parses as a subagent transcript. Schema v30 added `turn_index`,
 * `sequence_in_turn`, `ts`, `agent_name`, `skill_name`, `arguments_json`,
 * `file_path` and `file_op`; `sessionDetailFromDb` reads them for exactly those
 * sessions. **No existing query changed**, which is the whole reason that
 * option was taken over moving the rows into `tool_uses` — that would have
 * shifted 23 `FROM tool_uses` sites across 11 modules as a side effect.
 *
 * ## Why this test asserts what it does
 *
 * #511 is explicit about the bar, because the same trap had already been
 * sprung once: "#484's test asserted non-null and thereby ratified #487; the
 * same shape of assertion would ratify this." So a non-empty check is exactly
 * what must NOT be relied on here. This asserts the calls appear
 *
 *   - in TRANSCRIPT ORDER,
 *   - with their ARGUMENTS,
 *   - in all three surfaces the issue names (timeline, tools panel, files),
 *
 * and separately that `tool_uses` is still untouched, since the containment is
 * the reason the fix was acceptable at all.
 */

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({
  prefix: "pm-subagent-tools-",
  env: { MINDER_USE_DB: "1" },
});
let tmpHome: string;

const USAGE = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

beforeEach(() => {
  tmpHome = state.tmpHome();
});

describe.skipIf(!driverAvailable)("#511 delegated tool and file panels", () => {
  it("lists the agent's calls in order, with arguments, in every panel", async () => {
    await state.reload();
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const conn = await import("@/lib/db/connection");
    const mig = await import("@/lib/db/migrations");
    const ingest = await import("@/lib/db/ingest");
    expect((await mig.initDb()).error).toBeNull();
    const db = (await conn.getDb())!;

    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const root = path.join(projectsDir, "C--dev-myapp", "cafe99.jsonl");
    await fs.mkdir(path.dirname(root), { recursive: true });
    await fs.writeFile(
      root,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-01T10:00:00Z",
        isSidechain: false,
        message: {
          id: "m1",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "ok" }],
          usage: USAGE,
        },
      }) + "\n"
    );

    // Four calls, deliberately NOT in alphabetical or tool-name order, so an
    // implementation that sorted by anything other than the transcript would
    // produce a different sequence. `Read` appears twice with different paths,
    // so a per-name aggregation cannot stand in for ordering either.
    const line = (ts: string, id: string, blocks: unknown[]) =>
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        isSidechain: true,
        message: { id, model: "claude-sonnet-4-5", content: blocks, usage: USAGE },
      });
    const agent = path.join(
      projectsDir,
      "C--dev-myapp",
      "cafe99",
      "subagents",
      "agent-x.jsonl"
    );
    await fs.mkdir(path.dirname(agent), { recursive: true });
    await fs.writeFile(
      agent,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-08-01T10:05:00Z",
          isSidechain: true,
          message: { content: [{ type: "text", text: "sweep it" }] },
        }),
        line("2026-08-01T10:06:00Z", "s0", [
          { type: "tool_use", id: "t1", name: "Glob", input: { pattern: "**/*.ts" } },
        ]),
        line("2026-08-01T10:07:00Z", "s1", [
          { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/repo/a.ts" } },
        ]),
        line("2026-08-01T10:08:00Z", "s2", [
          { type: "tool_use", id: "t3", name: "Edit", input: { file_path: "/repo/b.ts" } },
        ]),
        line("2026-08-01T10:09:00Z", "s3", [
          { type: "tool_use", id: "t4", name: "Read", input: { file_path: "/repo/c.ts" } },
        ]),
      ].join("\n") + "\n"
    );

    expect((await ingest.reconcileAllSessions(db, { projectsDir })).errors).toBe(0);

    const { loadSessionDetailFromDb } = await import("@/lib/data/sessionDetailFromDb");
    const detail = await loadSessionDetailFromDb(db, "agent-x");
    expect(detail).not.toBeNull();

    // ── Timeline: order AND arguments ──────────────────────────────────────
    const toolEvents = detail!.timeline.filter((e) => e.type === "tool_use");
    expect(toolEvents.map((e) => e.toolName)).toEqual(["Glob", "Read", "Edit", "Read"]);
    // The arguments, which are what distinguish the two `Read`s and are the
    // half `sidechain_tool_uses` could not carry before schema v30.
    expect(toolEvents.map((e) => e.toolInput)).toEqual([
      { pattern: "**/*.ts" },
      { file_path: "/repo/a.ts" },
      { file_path: "/repo/b.ts" },
      { file_path: "/repo/c.ts" },
    ]);

    // ── Tools panel ────────────────────────────────────────────────────────
    expect(detail!.toolUsage).toEqual({ Glob: 1, Read: 2, Edit: 1 });

    // ── Files panel: paths, operations and order ───────────────────────────
    expect(
      detail!.fileOperations.map((f) => `${f.operation}:${f.path}`)
    ).toEqual(["read:/repo/a.ts", "edit:/repo/b.ts", "read:/repo/c.ts"]);

    // ── The containment that made this approach acceptable ─────────────────
    // Nothing reached `tool_uses`, so none of the 23 `FROM tool_uses` sites
    // across 11 modules moved. That is the property #511 weighed option 1
    // against option 2 on, so it is asserted rather than assumed.
    const primary = db
      .prepare("SELECT COUNT(*) AS n FROM tool_uses WHERE session_id = 'agent-x'")
      .get() as { n: number };
    expect(primary.n).toBe(0);
    // ...and they are all in the sidechain table, with ordering.
    const sidechain = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sidechain_tool_uses
          WHERE session_id = 'agent-x' AND turn_index IS NOT NULL`
      )
      .get() as { n: number };
    expect(sidechain.n).toBe(4);
  });

  it("leaves an ordinary session's panels reading from tool_uses", async () => {
    // The counterpart. The detail loader now chooses its table by path, so a
    // regression that pointed EVERY session at `sidechain_tool_uses` would
    // satisfy the test above and empty every ordinary session's panels.
    await state.reload();
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const conn = await import("@/lib/db/connection");
    const mig = await import("@/lib/db/migrations");
    const ingest = await import("@/lib/db/ingest");
    expect((await mig.initDb()).error).toBeNull();
    const db = (await conn.getDb())!;

    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const plain = path.join(projectsDir, "C--dev-myapp", "beef77.jsonl");
    await fs.mkdir(path.dirname(plain), { recursive: true });
    await fs.writeFile(
      plain,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-08-01T10:00:00Z",
          isSidechain: false,
          message: { content: [{ type: "text", text: "do it" }] },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-08-01T10:01:00Z",
          isSidechain: false,
          message: {
            id: "p1",
            model: "claude-sonnet-4-5",
            content: [
              { type: "tool_use", id: "p_1", name: "Read", input: { file_path: "/repo/z.ts" } },
            ],
            usage: USAGE,
          },
        }),
      ].join("\n") + "\n"
    );

    expect((await ingest.reconcileAllSessions(db, { projectsDir })).errors).toBe(0);

    const { loadSessionDetailFromDb } = await import("@/lib/data/sessionDetailFromDb");
    const detail = await loadSessionDetailFromDb(db, "beef77");
    expect(detail).not.toBeNull();
    expect(detail!.toolUsage).toEqual({ Read: 1 });
    expect(detail!.fileOperations.map((f) => f.path)).toEqual(["/repo/z.ts"]);
  });
});
