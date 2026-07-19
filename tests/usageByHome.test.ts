import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { aggregateUsage } from "@/lib/usage/aggregator";
import { emptyActivity } from "@/lib/usage/activityBuckets";
import { normalizePathKey } from "@/lib/platform";
import type { UsageTurn } from "@/lib/usage/types";
import type { MinderConfig } from "@/lib/types";

// #311 — the Claude-home discriminator for per-project usage/cost reports.
// Two configured homes with identical path layouts (Ubuntu + Debian both
// /home/me/dev/app) produce the SAME projectSlug; these tests prove the
// pipeline keeps their spend separable on both backends:
//   - aggregateUsage groups byProject per (slug, home) and emits `homeKey`
//   - generateUsageReport's `home` param filters turns by their home stamp
//   - DB ingest stamps sessions.home_key; loadUsageReportFromSql filters on it

const HOME_A = "//wsl.localhost/ubuntu/home/me/.claude";
const HOME_B = "//wsl.localhost/debian/home/me/.claude";

function makeTurn(overrides: Partial<UsageTurn> = {}): UsageTurn {
  return {
    timestamp: "2025-01-01T00:00:00Z",
    sessionId: "sess1",
    projectSlug: "-home-me-dev-app",
    projectDirName: "-home-me-dev-app",
    model: "claude-opus-4-7",
    role: "assistant",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    source: "claude",
    ...overrides,
  };
}

describe("aggregateUsage byProject — (slug, home) composite grouping", () => {
  it("keeps two homes with the same slug as separate rows carrying homeKey", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ sessionId: "a1", homeKey: HOME_A, inputTokens: 100, outputTokens: 0 }),
      makeTurn({ sessionId: "a2", homeKey: HOME_A, inputTokens: 100, outputTokens: 0 }),
      makeTurn({ sessionId: "b1", homeKey: HOME_B, inputTokens: 300, outputTokens: 0 }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());

    expect(report.byProject).toHaveLength(2);
    const rowA = report.byProject.find((r) => r.homeKey === HOME_A);
    const rowB = report.byProject.find((r) => r.homeKey === HOME_B);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    expect(rowA!.projectSlug).toBe("-home-me-dev-app");
    expect(rowB!.projectSlug).toBe("-home-me-dev-app");
    expect(rowA!.tokens).toBe(200);
    expect(rowB!.tokens).toBe(300);
    expect(rowA!.turns).toBe(2);
    expect(rowB!.turns).toBe(1);
  });

  it("emits a single row without homeKey for unstamped turns (single-home / legacy)", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ sessionId: "s1" }),
      makeTurn({ sessionId: "s2" }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());
    expect(report.byProject).toHaveLength(1);
    expect("homeKey" in report.byProject[0]).toBe(false);
    expect(report.byProject[0].turns).toBe(2);
  });

  it("keeps stamped and unstamped turns of one slug as distinct rows", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ sessionId: "s1", homeKey: HOME_A }),
      makeTurn({ sessionId: "s2" }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());
    expect(report.byProject).toHaveLength(2);
  });
});

describe("generateUsageReport — home filter (file backend)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("scopes totals to the requested home's turns only", async () => {
    // Reset the registry FIRST — the static aggregator import at the top of
    // this file already cached it against the real parser; doMock only
    // affects modules imported after a reset.
    vi.resetModules();
    const sessionMap = new Map<string, UsageTurn[]>([
      ["a1", [makeTurn({ sessionId: "a1", homeKey: HOME_A, inputTokens: 100, outputTokens: 0 })]],
      ["b1", [makeTurn({ sessionId: "b1", homeKey: HOME_B, inputTokens: 300, outputTokens: 0 })]],
      // Unstamped turn: strict filtering must exclude it, not guess.
      ["u1", [makeTurn({ sessionId: "u1", inputTokens: 700, outputTokens: 0 })]],
    ]);
    vi.doMock("@/lib/usage/parser", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/usage/parser")>()),
      parseAllSessions: vi.fn(async () => sessionMap),
    }));
    const { generateUsageReport } = await import("@/lib/usage/aggregator");

    const filtered = await generateUsageReport("all", "-home-me-dev-app", undefined, HOME_A);
    expect(filtered.totalTokens).toBe(100);
    expect(filtered.totalTurns).toBe(1);

    const unfiltered = await generateUsageReport("all", "-home-me-dev-app");
    expect(unfiltered.totalTokens).toBe(1100);
  });
});

// ── DB backend: ingest stamps home_key; SQL report filters on it ───────────

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

interface JsonlEntry {
  type: "user" | "assistant";
  timestamp: string;
  message?: unknown;
}

async function writeJsonl(filePath: string, entries: JsonlEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function assistantTurn(timestamp: string, inputTokens: number): JsonlEntry {
  return {
    type: "assistant",
    timestamp,
    message: {
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "work" }],
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

async function reloadModules() {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return {
    fromDb: await import("@/lib/data/usageFromDb"),
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
    ingest: await import("@/lib/db/ingest"),
  };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-usage-home-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe.skipIf(!driverAvailable)("home_key end-to-end: multi-home ingest → SQL report", () => {
  it("stamps each session with its owning home and filters the report on it", async () => {
    // Primary home = <tmp>/.claude (homedir mock); extra home = <tmp>/extra/.claude.
    // Both record a session under the SAME encoded dirname → same project_slug.
    const primaryHome = path.join(tmpHome, ".claude");
    const extraHome = path.join(tmpHome, "extra", ".claude");
    const dirName = "-home-me-dev-app";
    await writeJsonl(path.join(primaryHome, "projects", dirName, "sess-a.jsonl"), [
      assistantTurn("2025-01-01T10:00:00Z", 100),
    ]);
    await writeJsonl(path.join(extraHome, "projects", dirName, "sess-b.jsonl"), [
      assistantTurn("2025-01-02T10:00:00Z", 300),
    ]);

    const mods = await reloadModules();
    const init = await mods.mig.initDb();
    expect(init.available).toBe(true);
    const db = (await mods.conn.getDb())!;
    const config = { claudeHomes: [extraHome] } as unknown as MinderConfig;
    await mods.ingest.reconcileAllSessions(db, { config });

    const primaryKey = normalizePathKey(primaryHome);
    const extraKey = normalizePathKey(extraHome);
    const rows = db
      .prepare("SELECT session_id, home_key FROM sessions ORDER BY session_id")
      .all() as Array<{ session_id: string; home_key: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.session_id === "sess-a")?.home_key).toBe(primaryKey);
    expect(rows.find((r) => r.session_id === "sess-b")?.home_key).toBe(extraKey);

    // toSlug drops the leading dash of POSIX-encoded dirnames.
    const slug = "home-me-dev-app";
    const all = mods.fromDb.loadUsageReportFromSql(db, "all", slug);
    expect(all.totalTokens).toBe(400);
    // One byProject row per (slug, home), each carrying its homeKey.
    expect(all.byProject).toHaveLength(2);
    expect(new Set(all.byProject.map((r) => r.homeKey))).toEqual(
      new Set([primaryKey, extraKey])
    );

    const onlyPrimary = mods.fromDb.loadUsageReportFromSql(db, "all", slug, undefined, primaryKey);
    expect(onlyPrimary.totalTokens).toBe(100);
    expect(onlyPrimary.totalSessions).toBe(1);
    expect(onlyPrimary.byProject).toHaveLength(1);
    expect(onlyPrimary.byProject[0].homeKey).toBe(primaryKey);

    const onlyExtra = mods.fromDb.loadUsageReportFromSql(db, "all", slug, undefined, extraKey);
    expect(onlyExtra.totalTokens).toBe(300);
    expect(onlyExtra.totalSessions).toBe(1);

    mods.conn.closeDb();
  });
});
