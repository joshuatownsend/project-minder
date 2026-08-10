/**
 * A3 — session segmentation by entrypoint.
 *
 * The load-bearing test is dual-backend parity. `byEntrypoint` is assembled
 * twice: by `aggregator.ts` walking turns from JSONL, and by a `GROUP BY` in
 * `usageFromDb.ts`. Either can drift, and the drift is invisible in normal use
 * because a given install only ever runs one of them depending on
 * `MINDER_USE_DB`. A2 shipped exactly this class of bug twice — an adapter path
 * that never stamped its column, and an empty-string value one side normalized
 * and the other did not.
 *
 * This breakdown is also the first **session-scoped** one on the report, so its
 * distinct-session counting is tested explicitly: the failure mode is reporting
 * a turn count under a session-shaped label, which looks plausible and is off
 * by an order of magnitude.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import {
  UNKNOWN_ENTRYPOINT,
  entrypointBucket,
  compareEntrypoint,
  entrypointLabel,
  isAutomatedEntrypoint,
  isBackgroundSession,
} from "@/lib/usage/entrypoint";
import type { EntrypointBreakdown } from "@/lib/usage/types";
import { installIsolatedState } from "./_helpers/isolatedState";

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

describe("entrypoint bucketing", () => {
  it("collapses absent / null / empty to the unknown bucket", () => {
    expect(entrypointBucket(undefined)).toBe(UNKNOWN_ENTRYPOINT);
    expect(entrypointBucket(null)).toBe(UNKNOWN_ENTRYPOINT);
    // The empty string is the case that shipped as a real backend divergence
    // in A2: the TS bucketed it, the SQL only COALESCEd NULL.
    expect(entrypointBucket("")).toBe(UNKNOWN_ENTRYPOINT);
  });

  it("passes an unrecognized entrypoint through instead of swallowing it", () => {
    expect(entrypointBucket("sdk-go")).toBe("sdk-go");
  });

  it("orders human-driven first, then SDK variants, unknown last", () => {
    const sorted = ["unknown", "sdk-py", "cli", "sdk-cli"].sort(compareEntrypoint);
    expect(sorted).toEqual(["cli", "sdk-cli", "sdk-py", "unknown"]);
  });

  it("sorts unrecognized entrypoints after unknown, stably", () => {
    const sorted = ["zzz-future", "unknown", "cli"].sort(compareEntrypoint);
    expect(sorted).toEqual(["cli", "unknown", "zzz-future"]);
  });

  it("labels the raw values, which are jargon on their own", () => {
    expect(entrypointLabel("cli")).toBe("Interactive");
    expect(entrypointLabel("sdk-py")).toBe("SDK (Python)");
    // An unknown key falls back to itself rather than rendering "undefined".
    expect(entrypointLabel("sdk-go")).toBe("sdk-go");
  });
});

describe("isAutomatedEntrypoint", () => {
  it("treats every sdk- variant as automated, including unseen ones", () => {
    expect(isAutomatedEntrypoint("sdk-cli")).toBe(true);
    expect(isAutomatedEntrypoint("sdk-py")).toBe(true);
    // The reason it is prefix-keyed: a future SDK must not silently count as
    // supervised, which would inflate every "what did I do today" figure.
    expect(isAutomatedEntrypoint("sdk-go")).toBe(true);
  });

  it("does NOT treat interactive or unknown as automated", () => {
    expect(isAutomatedEntrypoint("cli")).toBe(false);
    // Absence is not evidence — guessing here would file unclassifiable
    // sessions into whichever bucket the guess favoured.
    expect(isAutomatedEntrypoint(UNKNOWN_ENTRYPOINT)).toBe(false);
  });
});

describe("isBackgroundSession", () => {
  it("recognizes only the observed `bg` marker", () => {
    expect(isBackgroundSession("bg")).toBe(true);
    expect(isBackgroundSession(undefined)).toBe(false);
    expect(isBackgroundSession(null)).toBe(false);
    // Absence means "not flagged as background", not "unknown" — 99.9% of
    // sessions carry no sessionKind at all.
    expect(isBackgroundSession("interactive")).toBe(false);
  });
});

// ── dual-backend parity ────────────────────────────────────────────────────

const state = installIsolatedState({ prefix: "pm-a3-", preserveEnv: ["MINDER_USE_DB"] });

/** Mirror of the helper's temp home, so fixture paths below read unchanged. */
let tmpHome: string;

beforeEach(() => {
  tmpHome = state.tmpHome();
});

function assistant(ts: string, tokens = 100) {
  return {
    type: "assistant",
    timestamp: ts,
    message: {
      model: "claude-opus-5",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: tokens,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

/**
 * `entrypoint` / `sessionKind` ride **attachment** entries, not assistant
 * turns. Putting them on an assistant entry here would let a reader that looks
 * in the wrong place pass — the same mistake A1's plan made before the corpus
 * was probed.
 */
function attachment(ts: string, entrypoint: string, sessionKind?: string) {
  const e: Record<string, unknown> = {
    type: "attachment",
    timestamp: ts,
    uuid: `att-${ts}`,
    entrypoint,
  };
  if (sessionKind !== undefined) e.sessionKind = sessionKind;
  return e;
}

function userTurn(ts: string, text: string) {
  return { type: "user", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } };
}

/**
 * Four sessions:
 *   interactive-1                    cli      2 assistant turns
 *   interactive-2                    cli      1 assistant turn,  flagged `bg`
 *   interactive-1/subagents/agent-1  cli      1 assistant turn
 *   batch-1                          sdk-cli  3 assistant turns
 *
 * The three `cli` sessions are what make the distinct-session count
 * meaningful: that bucket has 4 turns across 3 sessions, so a `sessions` field
 * reporting 4 is counting the wrong thing.
 *
 * **The nested subagent transcript is load-bearing.** Newer Claude Code writes
 * subagent turns to `<session>/subagents/*.jsonl` rather than inlining them,
 * and the SQLite reconciler walks one level down to find them while the
 * file-backend reader originally did not — so the two backends disagreed on
 * roughly a quarter of the real corpus. The first version of this fixture
 * contained only top-level files, which is exactly why the parity test passed
 * while the divergence was live (Codex review, PR #381). A fixture that cannot
 * see the difference between the two readers does not test parity.
 */
async function writeFixture(): Promise<void> {
  const dir = path.join(tmpHome, ".claude", "projects", "C--dev-x");
  await fs.mkdir(dir, { recursive: true });

  const write = async (name: string, entries: unknown[]) =>
    fs.writeFile(
      path.join(dir, name),
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
    );

  await write("interactive-1.jsonl", [
    userTurn("2026-08-01T10:00:00Z", "hello"),
    attachment("2026-08-01T10:00:01Z", "cli"),
    assistant("2026-08-01T10:00:02Z"),
    assistant("2026-08-01T10:00:03Z"),
  ]);

  await write("interactive-2.jsonl", [
    userTurn("2026-08-01T11:00:00Z", "hello again"),
    attachment("2026-08-01T11:00:01Z", "cli", "bg"),
    assistant("2026-08-01T11:00:02Z"),
  ]);

  await write("batch-1.jsonl", [
    userTurn("2026-08-01T12:00:00Z", "generate"),
    attachment("2026-08-01T12:00:01Z", "sdk-cli"),
    assistant("2026-08-01T12:00:02Z"),
    assistant("2026-08-01T12:00:03Z"),
    assistant("2026-08-01T12:00:04Z"),
  ]);

  // Nested subagent transcript. Carries its parent's entrypoint, which is why
  // omitting these understated `cli` specifically rather than every bucket
  // evenly.
  const subDir = path.join(dir, "interactive-1", "subagents");
  await fs.mkdir(subDir, { recursive: true });
  await fs.writeFile(
    path.join(subDir, "agent-1.jsonl"),
    [
      userTurn("2026-08-01T10:10:00Z", "delegated task"),
      attachment("2026-08-01T10:10:01Z", "cli"),
      assistant("2026-08-01T10:10:02Z"),
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n"
  );
}

function byKey(rows: EntrypointBreakdown[]): Record<string, EntrypointBreakdown> {
  return Object.fromEntries(rows.map((r) => [r.entrypoint, r]));
}

describe.skipIf(!driverAvailable)("byEntrypoint — file-parse vs SQLite parity", () => {
  async function reportFrom(useDb: boolean): Promise<EntrypointBreakdown[]> {
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
      });
    }
    const data = await import("@/lib/data");
    const { report, meta } = await data.getUsage("all", undefined);
    // If the DB leg silently fell back to file-parse the two legs would
    // trivially agree and prove nothing.
    expect(meta.backend).toBe(useDb ? "db" : "file");
    return report.byEntrypoint;
  }

  it("produces identical entrypoint buckets on both backends", async () => {
    await writeFixture();
    const fileRows = await reportFrom(false);
    const dbRows = await reportFrom(true);

    expect(dbRows.map((r) => r.entrypoint)).toEqual(fileRows.map((r) => r.entrypoint));

    for (const key of fileRows.map((r) => r.entrypoint)) {
      const f = byKey(fileRows)[key];
      const d = byKey(dbRows)[key];
      expect({ key, ...pick(d) }).toEqual({ key, ...pick(f) });
    }

    function pick(r: EntrypointBreakdown) {
      return {
        sessions: r.sessions,
        turns: r.turns,
        tokens: r.tokens,
        backgroundSessions: r.backgroundSessions,
      };
    }
  });

  it("decodes entrypoint from attachment entries, not assistant turns", async () => {
    await writeFixture();
    const rows = byKey(await reportFrom(false));
    // If the reader looked at assistant entries it would find nothing and
    // every session would land in `unknown`.
    expect(Object.keys(rows).sort()).toEqual(["cli", "sdk-cli"]);
    expect(rows[UNKNOWN_ENTRYPOINT]).toBeUndefined();
  });

  it.each([true, false])("counts DISTINCT sessions, not turns (useDb=%s)", async (useDb) => {
    await writeFixture();
    const rows = byKey(await reportFrom(useDb));

    // The whole point of the session-scoped shape: 4 cli turns, 3 cli sessions
    // (two top-level plus the nested subagent transcript).
    expect(rows.cli.turns).toBe(4);
    expect(rows.cli.sessions).toBe(3);

    expect(rows["sdk-cli"].turns).toBe(3);
    expect(rows["sdk-cli"].sessions).toBe(1);
  });

  it.each([true, false])(
    "counts nested subagent transcripts on both backends (useDb=%s)",
    async (useDb) => {
      await writeFixture();
      const rows = byKey(await reportFrom(useDb));

      // Subagent transcripts live at `<session>/subagents/*.jsonl`. The
      // reconciler always walked into them; the file reader did not, so the
      // file backend silently dropped ~26% of the real corpus — and because
      // those transcripts inherit their parent's entrypoint, the loss landed
      // almost entirely on `cli`. Without the nested file this fixture cannot
      // tell the two readers apart.
      expect(rows.cli.sessions).toBe(3);
    }
  );

  it.each([true, false])(
    "flags background sessions without moving them out of their bucket (useDb=%s)",
    async (useDb) => {
      await writeFixture();
      const rows = byKey(await reportFrom(useDb));

      // `bg` is a flag, not a peer bucket — the backgrounded session is still
      // counted in `cli`, and there is no separate `bg` row.
      expect(rows.bg).toBeUndefined();
      expect(rows.cli.sessions).toBe(3);
      expect(rows.cli.backgroundSessions).toBe(1);
      expect(rows["sdk-cli"].backgroundSessions).toBe(0);
    }
  );

  it.each([true, false])(
    "divides cost by the session count, not the turn count (useDb=%s)",
    async (useDb) => {
      await writeFixture();
      const rows = byKey(await reportFrom(useDb));

      for (const r of Object.values(rows)) {
        expect(r.sessions).toBeGreaterThan(0);
        expect(r.avgCostPerSession).toBeCloseTo(r.cost / r.sessions, 10);
        // Guards against the plausible-looking wrong denominator.
        if (r.turns !== r.sessions) {
          expect(r.avgCostPerSession).not.toBeCloseTo(r.cost / r.turns, 10);
        }
      }
    }
  );

  it("orders rows by the fixed scale on both backends, not by cost", async () => {
    await writeFixture();
    // sdk-cli has more turns than cli here, so a cost-sorted list would put it
    // first. The fixed order is what keeps the rows comparable between periods.
    for (const useDb of [false, true]) {
      const rows = await reportFrom(useDb);
      expect(rows.map((r) => r.entrypoint)).toEqual(["cli", "sdk-cli"]);
    }
  });
});
