import { describe, it, expect } from "vitest";
import { installIsolatedState } from "./_helpers/isolatedState";

// Item 4b — daily grade snapshots + trend classification.
//
// Pure helpers (`classifyGradeTrend`, `snapshotDate`) are tested directly.
// The write/read round-trip drives the REAL DB backend (migrations create the
// v16 table; snapshot functions self-init via ensureSchemaReady) with an
// injected `now` so "yesterday vs today" is deterministic. Skipped when
// better-sqlite3 isn't loadable.
//
// Dates are built with the local-time Date constructor (new Date(y, mIdx, d))
// so the LOCAL snapshot_date the code derives is timezone-independent in CI.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const COUNTS = { high: 0, medium: 0, low: 0 };

// `classifyGradeTrend` and `snapshotDate` are pure, but they live in a module
// whose first lines import `getDb` from `@/lib/db/connection` — so importing
// them statically froze `DB_DIR` to the real `~/.minder` before any isolation
// in this file ran. Harmless in practice (nothing here called through to the
// connection) but safe only by argument, and invisible at the call site; the
// isolation guard in `dbIsolationGuard.test.ts` now rejects the shape. Loading
// them through the same `reload()` the DB cases use removes the exception
// rather than documenting it (#331).
const state = installIsolatedState({
  prefix: "pm-grade-snap-",
  env: { MINDER_USE_DB: "1" },
});

async function reload() {
  await state.reload();
  return {
    snaps: await import("@/lib/data/gradeSnapshots"),
    conn: await import("@/lib/db/connection"),
  };
}

describe("classifyGradeTrend", () => {
  it("returns 'new' when there is no prior grade", async () => {
    const { snaps } = await reload();
    expect(snaps.classifyGradeTrend(null, "C")).toBe("new");
  });
  it("returns 'improving' when the letter gets better (D → C)", async () => {
    const { snaps } = await reload();
    expect(snaps.classifyGradeTrend("D", "C")).toBe("improving");
  });
  it("returns 'declining' when the letter gets worse (B → D)", async () => {
    const { snaps } = await reload();
    expect(snaps.classifyGradeTrend("B", "D")).toBe("declining");
  });
  it("returns 'stable' when the letter is unchanged", async () => {
    const { snaps } = await reload();
    expect(snaps.classifyGradeTrend("B", "B")).toBe("stable");
  });
  it("treats A as best and F as worst", async () => {
    const { snaps } = await reload();
    expect(snaps.classifyGradeTrend("F", "A")).toBe("improving");
    expect(snaps.classifyGradeTrend("A", "F")).toBe("declining");
  });
});

describe("snapshotDate", () => {
  it("formats the local calendar date as YYYY-MM-DD", async () => {
    // Local-time constructor → the helper's local getters round-trip exactly,
    // regardless of the machine timezone.
    const { snaps } = await reload();
    expect(snaps.snapshotDate(new Date(2026, 4, 10, 12, 0, 0))).toBe("2026-05-10");
    expect(snaps.snapshotDate(new Date(2026, 0, 3, 9, 30, 0))).toBe("2026-01-03");
  });
});

// ── DB-backed round-trip ─────────────────────────────────────────────────────

// Three distinct LOCAL days.
const DAY1 = new Date(2026, 4, 10, 12, 0, 0);
const DAY2 = new Date(2026, 4, 11, 12, 0, 0);
const DAY3 = new Date(2026, 4, 12, 12, 0, 0);

describe.skipIf(!driverAvailable)("recordGradeSnapshot + loadGradeTrend (DB)", () => {
  it("creates the v16 table on first write and reports 'new' with no prior snapshot", async () => {
    const { snaps } = await reload();
    await snaps.recordGradeSnapshot({ slug: "proj", grade: "C", counts: { high: 0, medium: 2, low: 1 } }, DAY1);
    // Only DAY1's row exists; the trend query looks at snapshot_date < DAY1,
    // so there is no prior → "new".
    expect(await snaps.loadGradeTrend("proj", "C", DAY1)).toBe("new");
  });

  it("classifies improving across days (D yesterday → C today)", async () => {
    const { snaps } = await reload();
    await snaps.recordGradeSnapshot({ slug: "proj", grade: "D", counts: COUNTS }, DAY1);
    await snaps.recordGradeSnapshot({ slug: "proj", grade: "C", counts: COUNTS }, DAY2);
    expect(await snaps.loadGradeTrend("proj", "C", DAY2)).toBe("improving");
  });

  it("classifies declining across days (B → D)", async () => {
    const { snaps } = await reload();
    await snaps.recordGradeSnapshot({ slug: "proj", grade: "B", counts: COUNTS }, DAY1);
    await snaps.recordGradeSnapshot({ slug: "proj", grade: "D", counts: COUNTS }, DAY2);
    expect(await snaps.loadGradeTrend("proj", "D", DAY2)).toBe("declining");
  });

  it("compares against the MOST-RECENT prior day, not the oldest", async () => {
    const { snaps } = await reload();
    await snaps.recordGradeSnapshot({ slug: "proj", grade: "F", counts: COUNTS }, DAY1);
    await snaps.recordGradeSnapshot({ slug: "proj", grade: "C", counts: COUNTS }, DAY2);
    // DAY3 current C vs most-recent prior (DAY2 C) → stable, NOT vs DAY1 F.
    expect(await snaps.loadGradeTrend("proj", "C", DAY3)).toBe("stable");
  });

  it("upsert is idempotent within a day — overwrites, never duplicates", async () => {
    const { snaps, conn } = await reload();
    await snaps.recordGradeSnapshot({ slug: "proj", grade: "C", counts: { high: 1, medium: 0, low: 0 } }, DAY1);
    await snaps.recordGradeSnapshot({ slug: "proj", grade: "A", counts: { high: 0, medium: 0, low: 0 } }, DAY1);

    const db = (await conn.getDb())!;
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n, MAX(grade) AS grade, MAX(high_count) AS high FROM project_grade_snapshots WHERE project_slug = 'proj' AND snapshot_date = ?"
      )
      .get(snaps.snapshotDate(DAY1)) as { n: number; grade: string; high: number };
    expect(row.n).toBe(1); // one row for the day, not two
    expect(row.grade).toBe("A"); // last write wins
    expect(row.high).toBe(0);
  });
});

describe.skipIf(!driverAvailable)("loadGradeTrends — bulk (DB)", () => {
  it("classifies many projects against their own most-recent prior snapshot", async () => {
    const { snaps } = await reload();
    // Yesterday's grades.
    await snaps.recordGradeSnapshots(
      [
        { slug: "up", grade: "D", counts: COUNTS },
        { slug: "down", grade: "A", counts: COUNTS },
        { slug: "same", grade: "C", counts: COUNTS },
      ],
      DAY1
    );
    // Today's grades (also written, but the trend reads snapshot_date < today).
    await snaps.recordGradeSnapshots(
      [
        { slug: "up", grade: "B", counts: COUNTS },
        { slug: "down", grade: "F", counts: COUNTS },
        { slug: "same", grade: "C", counts: COUNTS },
      ],
      DAY2
    );

    const trends = await snaps.loadGradeTrends(
      { up: "B", down: "F", same: "C", fresh: "A" },
      DAY2
    );
    expect(trends.up).toBe("improving"); // D → B
    expect(trends.down).toBe("declining"); // A → F
    expect(trends.same).toBe("stable"); // C → C
    expect(trends.fresh).toBe("new"); // never snapshotted
  });
});

describe("graceful degradation", () => {
  it("returns null trend and no-ops the write when MINDER_USE_DB=0", async () => {
    process.env.MINDER_USE_DB = "0";
    const { snaps } = await reload();
    await snaps.recordGradeSnapshot({ slug: "proj", grade: "C", counts: COUNTS }, DAY1);
    expect(await snaps.loadGradeTrend("proj", "C", DAY1)).toBeNull();
    expect(await snaps.loadGradeTrends({ proj: "C" }, DAY1)).toEqual({});
  });
});
