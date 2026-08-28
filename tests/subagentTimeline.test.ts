/**
 * #487 — a subagent session used to open with an EMPTY TIMELINE.
 *
 * `turns.is_sidechain` means "this turn is a sidechain OF ITS PARENT". Correct
 * for an ordinary transcript, wrong for `<session>/subagents/agent-*.jsonl`,
 * where the file IS the subagent's own conversation and every entry carries the
 * flag. Routed through the sidechain branch, ingest stored skeletons: on the
 * real index, `agent-a38db58938dbeea68` had 9 rows, all assistant, every
 * `text_preview` NULL, and `turn_count = 0`.
 *
 * So when #483/#484 made these sessions resolve instead of 404ing, they opened
 * to nothing — which reads as a real session that did no work, and is arguably
 * worse than the error it replaced.
 *
 * **Every fixture here sets `isSidechain: true` on every line.** PR #484's
 * end-to-end test omitted the field, which is exactly what a real transcript
 * always carries, and so it asserted only that the detail was non-null — it
 * ratified this defect rather than catching it. These assert the timeline is
 * non-empty AND contains known text.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import os from "os";
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

const state = installIsolatedState({
  prefix: "pm-subagent-timeline-",
  env: { MINDER_USE_DB: "1" },
});
let tmpHome: string;

async function reload() {
  await state.reload();
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  const ingest = await import("@/lib/db/ingest");
  const detail = await import("@/lib/data/sessionDetailFromDb");
  const list = await import("@/lib/data/sessionsListFromDb");
  return { conn, mig, ingest, detail, list };
}

const USAGE = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const AGENT_PROMPT = "scan the repo for stale feature flags";
const AGENT_REPLY = "Found three stale flags in featureFlags.ts";

function userLine(ts: string, text: string, isSidechain: boolean) {
  return JSON.stringify({
    type: "user",
    timestamp: ts,
    isSidechain,
    message: { content: [{ type: "text", text }] },
  });
}

function assistantLine(ts: string, id: string, text: string, isSidechain: boolean) {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    isSidechain,
    message: {
      id,
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: USAGE,
    },
  });
}

async function writeRoot(projectsDir: string, sessionId: string) {
  const file = path.join(projectsDir, "C--dev-myapp", `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    [
      userLine("2026-08-01T10:00:00Z", "audit the flags", false),
      assistantLine("2026-08-01T10:00:01Z", "r1", "Delegating to an agent.", false),
    ].join("\n") + "\n"
  );
}

/** Every line sidechain — which is what these files really look like. */
async function writeSubagent(projectsDir: string, parentId: string, agentId: string) {
  const file = path.join(
    projectsDir,
    "C--dev-myapp",
    parentId,
    "subagents",
    `${agentId}.jsonl`
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    [
      userLine("2026-08-01T10:00:02Z", AGENT_PROMPT, true),
      assistantLine("2026-08-01T10:00:03Z", "s1", AGENT_REPLY, true),
    ].join("\n") + "\n"
  );
}

beforeEach(() => {
  tmpHome = state.tmpHome();
});

describe.skipIf(!driverAvailable)("subagent session timeline (#487)", () => {
  const PARENT = "cafe11";
  const AGENT = "agent-beef22";

  async function seed() {
    const { conn, mig, ingest, detail, list } = await reload();
    const init = await mig.initDb();
    expect(init.error).toBeNull();
    const db = (await conn.getDb())!;
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    await writeRoot(projectsDir, PARENT);
    await writeSubagent(projectsDir, PARENT, AGENT);
    const stats = await ingest.reconcileAllSessions(db, {
      projectsDir,
      recordRun: "reconcile",
    });
    expect(stats.errors).toBe(0);
    return { db, detail, list };
  }

  it("stores the subagent's own conversation, not assistant skeletons", async () => {
    const { db } = await seed();
    const rows = db
      .prepare(
        `SELECT role, text_preview, is_sidechain FROM turns
          WHERE session_id = ? ORDER BY turn_index`
      )
      .all(AGENT) as Array<{
      role: string;
      text_preview: string | null;
      is_sidechain: number;
    }>;

    // The three things that were wrong at once, asserted separately so a
    // partial regression cannot hide behind a passing sibling.
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows.every((r) => r.is_sidechain === 0)).toBe(true);
    expect(rows.map((r) => r.text_preview)).toEqual([AGENT_PROMPT, AGENT_REPLY]);
  });

  it("gives the session a real turn_count", async () => {
    const { db } = await seed();
    const row = db
      .prepare(`SELECT turn_count FROM sessions WHERE session_id = ?`)
      .get(AGENT) as { turn_count: number };
    expect(row.turn_count).toBe(2);
  });

  it("renders a timeline containing the agent's actual text", async () => {
    // The reported symptom. `not.toBeNull()` alone is what #484 asserted, and
    // it passed against the defect — the content assertions are the test.
    const { db, detail } = await seed();
    const result = await detail.loadSessionDetailFromDb(db, AGENT);
    expect(result).not.toBeNull();
    expect(result!.timeline.length).toBeGreaterThan(0);
    const texts = result!.timeline.map((e) => e.content).join("\n");
    expect(texts).toContain(AGENT_PROMPT);
    expect(texts).toContain(AGENT_REPLY);
  });

  it("still keeps the subagent OUT of the sessions list", async () => {
    // Product decision, and it no longer falls out of `turn_count > 0` now
    // that the count is real. 1,268 of these exist on the reference index
    // against roughly as many top-level sessions, so listing them would about
    // double the browser for work the user delegated rather than ran. The
    // file-parse sweep never listed them either — it reads only `*.jsonl`
    // directly inside a project directory — so showing them on one backend
    // would be a divergence as well as a product change.
    const { db, list } = await seed();
    const sessions = list.loadSessionsListFromDb(db);
    const ids = sessions.map((s) => s.sessionId);
    expect(ids).toContain(PARENT);
    expect(ids).not.toContain(AGENT);
  });

  it("leaves the subagent's tool calls in sidechain_tool_uses", async () => {
    // `schema.sql` states it outright: `tool_uses` holds primary turns only,
    // and 23 `FROM tool_uses` sites across 11 modules read it with no
    // sidechain predicate. Letting these ride the primary path would have
    // shifted portfolio-wide tool analytics as a side effect of a fix about a
    // blank timeline, so the turn is primary and the calls are not.
    const { db } = await seed();
    const primary = db
      .prepare(`SELECT COUNT(*) AS n FROM tool_uses WHERE session_id = ?`)
      .get(AGENT) as { n: number };
    expect(primary.n).toBe(0);
  });

  it("does not disturb an ordinary transcript's sidechain entries", async () => {
    // The counterpart. A parent transcript that legitimately carries a few
    // sidechain entries must keep excluding them — which is why the rule reads
    // the PATH rather than asking whether every entry is flagged.
    const { conn, mig, ingest } = await reload();
    await mig.initDb();
    const db = (await conn.getDb())!;
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const file = path.join(projectsDir, "C--dev-myapp", "d00d33.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      [
        userLine("2026-08-01T11:00:00Z", "primary prompt", false),
        assistantLine("2026-08-01T11:00:01Z", "p1", "primary reply", false),
        assistantLine("2026-08-01T11:00:02Z", "p2", "nested chatter", true),
      ].join("\n") + "\n"
    );
    const stats = await ingest.reconcileAllSessions(db, { projectsDir });
    expect(stats.errors).toBe(0);

    const rows = db
      .prepare(
        `SELECT is_sidechain, text_preview FROM turns
          WHERE session_id = 'd00d33' ORDER BY turn_index`
      )
      .all() as Array<{ is_sidechain: number; text_preview: string | null }>;
    const flagged = rows.filter((r) => r.is_sidechain === 1);
    expect(flagged).toHaveLength(1);
    expect(rows.filter((r) => r.is_sidechain === 0)).toHaveLength(2);
  });
});
