import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";

// #655: the safety sweep runs `reconcileAllSessions` over every transcript for the life of the
// process. These pin the three cost cuts: Claude is not discovered twice, per-file statements
// are compiled once per connection, and a native watch earns a long sweep interval.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({ prefix: "pm-ingest-sweepcost-", preserveEnv: ["MINDER_USE_DB"] });
let tmpHome: string;

beforeEach(() => {
  tmpHome = state.tmpHome();
});

async function setup() {
  await state.reload();
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  const ingest = await import("@/lib/db/ingest");
  const init = await mig.initDb();
  expect(init.error).toBeNull();
  return { conn, ingest, db: (await conn.getDb())!, projectsDir: path.join(tmpHome, ".claude", "projects") };
}

function turnLines(prompt: string, at: string): string {
  const lines = [
    { type: "user", timestamp: at, message: { content: [{ type: "text", text: prompt }] } },
    {
      type: "assistant",
      timestamp: at,
      message: {
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe.skipIf(!driverAvailable)("ingest sweep cost (#655)", () => {
  it("compiles reconcileSessionFile's statements once per connection", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    const file = path.join(projectsDir, "C--dev-alpha", "s1.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, turnLines("first", "2026-04-30T10:00:00Z"));

    const prepare = vi.spyOn(db, "prepare");
    const preparedSql = () => prepare.mock.calls.map((c) => String(c[0]));

    await ingest.reconcileSessionFile(db, file, "C--dev-alpha"); // full write
    await ingest.reconcileSessionFile(db, file, "C--dev-alpha"); // unchanged → no-op gate
    // Two tail appends: both read the next turn index.
    await fs.appendFile(file, turnLines("second", "2026-04-30T10:01:00Z"));
    await ingest.reconcileSessionFile(db, file, "C--dev-alpha");
    await fs.appendFile(file, turnLines("third", "2026-04-30T10:02:00Z"));
    await ingest.reconcileSessionFile(db, file, "C--dev-alpha");

    const count = (needle: string) => preparedSql().filter((s) => s.includes(needle)).length;
    expect(count("byte_offset, derived_version FROM sessions WHERE session_id = ?")).toBe(1);
    expect(count("COALESCE(MAX(turn_index), -1) + 1 AS next_idx")).toBe(1);

    const turns = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = 's1'").get() as { n: number };
    expect(turns.n).toBe(6);
    conn.closeDb();
  });

  it("never runs Claude discovery in the adapter pass", async () => {
    const { conn, ingest, db, projectsDir } = await setup();
    await fs.mkdir(projectsDir, { recursive: true });
    const adapters = await import("@/lib/adapters");
    const disc = vi.spyOn(adapters, "discoverAllSessions");
    await ingest.reconcileAllSessions(db, { projectsDir, config: { enabledAdapters: ["claude"] } as never });
    expect(disc).toHaveBeenCalledWith(expect.anything(), { exclude: ["claude"] });
    conn.closeDb();
  });
});

describe("resolveSweepIntervalMs", () => {
  // Imported dynamically: a static import of ingestWatcher pins the real ~/.minder DB path
  // (see dbIsolationGuard.test.ts).
  let resolveSweepIntervalMs: typeof import("@/lib/db/ingestWatcher").resolveSweepIntervalMs;
  let nextSweepWakeMs: typeof import("@/lib/db/ingestWatcher").nextSweepWakeMs;
  beforeAll(async () => {
    await state.reload();
    ({ resolveSweepIntervalMs, nextSweepWakeMs } = await import("@/lib/db/ingestWatcher"));
  });

  it("wakes at most every 30 s, and exactly when a longer interval falls due", () => {
    expect(nextSweepWakeMs(300_000, 0)).toBe(30_000);
    expect(nextSweepWakeMs(300_000, 290_000)).toBe(10_000);
    // A 45 s override sweeps at 45 s, not at the next 30 s boundary (60 s).
    expect(nextSweepWakeMs(45_000, 0)).toBe(30_000);
    expect(nextSweepWakeMs(45_000, 30_000)).toBe(15_000);
    expect(nextSweepWakeMs(10_000, 0)).toBe(10_000);
    // Overdue (e.g. held off by the initial reconcile): retry soon, never a 0 ms spin.
    expect(nextSweepWakeMs(30_000, 40_000)).toBe(1_000);
  });

  it("stretches the sweep only under a native watch", () => {
    expect(resolveSweepIntervalMs("native", {})).toBe(300_000);
    expect(resolveSweepIntervalMs("chokidar", {})).toBe(30_000);
    expect(resolveSweepIntervalMs("sweep-only", {})).toBe(30_000);
    expect(resolveSweepIntervalMs("arming", {})).toBe(30_000);
  });

  it("honours a positive integer MINDER_SWEEP_INTERVAL_MS in every mode", () => {
    const env = { MINDER_SWEEP_INTERVAL_MS: "60000" };
    expect(resolveSweepIntervalMs("native", env)).toBe(60_000);
    expect(resolveSweepIntervalMs("sweep-only", env)).toBe(60_000);
  });

  it("ignores an unusable override", () => {
    for (const bad of ["", "0", "-5", "abc", "1.5"]) {
      expect(resolveSweepIntervalMs("native", { MINDER_SWEEP_INTERVAL_MS: bad })).toBe(300_000);
    }
  });
});
