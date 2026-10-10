import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import type { UsageTurn } from "@/lib/usage/types";
import { foldDirName, sameDirName } from "@/lib/usage/dirNameFold";
import { isProjectSession } from "@/lib/sessions/projectSessionMatch";
import { installIsolatedState } from "./_helpers/isolatedState";
import { assertReconcileClean } from "./_helpers/reconcile";

// #639 — same-named projects on different drives or roots share a usage slug (`toSlug` drops the drive)
// but not an encoded conversation dir. The `dirName` filter narrows a slug-scoped report to one dir on
// both backends; drive-letter dirs compare case-folded, other encodings exactly.

describe("dir name comparison", () => {
  it("folds drive-letter encodings only", () => {
    expect(sameDirName("C--dev-foo", "c--dev-foo")).toBe(true);
    expect(sameDirName("C--dev-foo", "D--dev-foo")).toBe(false);
    expect(sameDirName("-home-me-Dev-app", "-home-me-dev-app")).toBe(false);
    expect(foldDirName("-home-me-Dev-app")).toBe("-home-me-Dev-app");
  });

  it("folds ASCII only, as SQLite lower() does, so both backends pick the same sessions", () => {
    expect(foldDirName("C--Dev-École")).toBe("c--dev-École");
  });

  it("matches a session recorded under a drive-letter case variant", () => {
    expect(isProjectSession({ projectName: "c--dev-app" }, "C--dev-app")).toBe(true);
    expect(isProjectSession({ projectName: "D--dev-app" }, "C--dev-app")).toBe(false);
  });
});

function makeTurn(overrides: Partial<UsageTurn>): UsageTurn {
  return {
    timestamp: "2025-01-01T00:00:00Z",
    sessionId: "s",
    projectSlug: "dev-foo",
    projectDirName: "C--dev-foo",
    model: "claude-opus-4-7",
    role: "assistant",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    source: "claude",
    ...overrides,
  };
}

describe("generateUsageReport — dirName filter (file backend)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("narrows a slug to one dir, folding drive-letter case", async () => {
    vi.resetModules();
    const sessionMap = new Map<string, UsageTurn[]>([
      ["c1", [makeTurn({ sessionId: "c1", projectDirName: "C--dev-foo", inputTokens: 100 })]],
      ["c2", [makeTurn({ sessionId: "c2", projectDirName: "c--dev-foo", inputTokens: 50 })]],
      ["d1", [makeTurn({ sessionId: "d1", projectDirName: "D--dev-foo", inputTokens: 300 })]],
    ]);
    vi.doMock("@/lib/usage/parser", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/usage/parser")>()),
      parseAllSessions: vi.fn(async () => sessionMap),
      streamAllSessions: vi.fn(async (visit: (id: string, turns: UsageTurn[]) => void | Promise<void>) => {
        for (const [id, turns] of sessionMap) await visit(id, turns);
      }),
    }));
    const { generateUsageReport } = await import("@/lib/usage/aggregator");

    expect((await generateUsageReport("all", "dev-foo")).totalTokens).toBe(450);
    expect((await generateUsageReport("all", "dev-foo", undefined, undefined, "C--dev-foo")).totalTokens).toBe(150);
    expect((await generateUsageReport("all", "dev-foo", undefined, undefined, "D--dev-foo")).totalTokens).toBe(300);
  });
});

// ── DB backend ─────────────────────────────────────────────────────────────

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({ prefix: "pm-usage-dirname-" });
let tmpHome: string;

beforeEach(() => {
  tmpHome = state.tmpHome();
});

async function writeSession(filePath: string, inputTokens: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const entry = {
    type: "assistant",
    timestamp: "2025-01-01T10:00:00Z",
    message: {
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "work" }],
      usage: { input_tokens: inputTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
  await fs.writeFile(filePath, JSON.stringify(entry) + "\n");
}

describe.skipIf(!driverAvailable)("loadUsageReportFromSql — dirName filter", () => {
  it("narrows a shared slug to one dir, folding drive-letter case and nothing else", async () => {
    // One file per session in distinct dirs (a case-insensitive filesystem cannot hold case variants
    // side by side), then rewritten to the shapes under test.
    const projects = path.join(tmpHome, ".claude", "projects");
    const sessions: Array<[string, string, number]> = [
      ["c-upper", "C--dev-foo", 100],
      ["c-lower", "c--dev-foo", 50],
      ["d", "D--dev-foo", 300],
      ["posix-upper", "-home-me-Dev-foo", 7],
      ["posix-lower", "-home-me-dev-foo", 11],
    ];
    for (const [id, , tokens] of sessions) await writeSession(path.join(projects, `dir-${id}`, `${id}.jsonl`), tokens);

    await state.reload();
    const mig = await import("@/lib/db/migrations");
    const conn = await import("@/lib/db/connection");
    const ingest = await import("@/lib/db/ingest");
    const fromDb = await import("@/lib/data/usageFromDb");
    expect((await mig.initDb()).available).toBe(true);
    const db = (await conn.getDb())!;
    assertReconcileClean(await ingest.reconcileAllSessions(db, {}));
    const slugFor = (dir: string) => (dir.startsWith("-") ? "home-me-dev-foo" : "dev-foo");
    for (const [id, dir] of sessions) {
      db.prepare("UPDATE sessions SET project_dir_name = ?, project_slug = ? WHERE session_id = ?").run(dir, slugFor(dir), id);
    }

    const tokens = async (slug: string, dirName?: string) =>
      (await fromDb.loadUsageReportFromSql(db, "all", slug, undefined, undefined, { dirName })).totalTokens;
    expect(await tokens("dev-foo")).toBe(450);
    expect(await tokens("dev-foo", "C--dev-foo")).toBe(150);
    expect(await tokens("dev-foo", "c--dev-foo")).toBe(150);
    expect(await tokens("dev-foo", "D--dev-foo")).toBe(300);
    expect(await tokens("home-me-dev-foo", "-home-me-Dev-foo")).toBe(7);
    expect(await tokens("home-me-dev-foo", "-home-me-dev-foo")).toBe(11);

    // The per-project breakdown (byProject + its detail queries) is narrowed too.
    const report = await fromDb.loadUsageReportFromSql(db, "all", "dev-foo", undefined, undefined, { dirName: "D--dev-foo" });
    expect(report.byProject.map((p) => p.tokens)).toEqual([300]);
    conn.closeDb();
  });
});
