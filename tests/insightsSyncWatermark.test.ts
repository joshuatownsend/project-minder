import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { scanInsightsMd } from "@/lib/scanner/insightsMd";
import { flushSyncMarks, flushSyncMarksSync, setSyncMark, watermarkFor } from "@/lib/scanner/insightsSyncMarks";

// #612 — the sync that pulls insights out of session transcripts must not re-read transcripts it has
// already looked at. Its watermark used to be INSIGHTS.md's mtime alone, which only moves when
// something NEW is written, so a project with changing sessions and nothing new re-read all of them
// on every scan.

let root: string;
let home: string;
let project: string;
let sessionsDir: string;
let readSpy: ReturnType<typeof vi.spyOn>;
let jsonlReads: string[];

// captured before any spy is installed, so a re-mocked readFile can still reach the real one
const realReadFile = fs.promises.readFile.bind(fs.promises);
const g = globalThis as unknown as { __minderInsightsMarks?: unknown };

function session(name: string, insight: string | null, mtimeMs: number) {
  const text = insight ? `\`★ Insight ─────────────────────────────────────\`\n${insight}\n\`─────────────────────────────────────────────────\`` : "plain reply";
  const file = path.join(sessionsDir, `${name}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "assistant", timestamp: "2026-10-01T00:00:00Z", message: { content: [{ type: "text", text }] } }) + "\n");
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

function touchInsights(mtimeMs: number) {
  fs.utimesSync(path.join(project, "INSIGHTS.md"), mtimeMs / 1000, mtimeMs / 1000);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "insights-wm-"));
  home = path.join(root, "home");
  project = path.join(root, "proj");
  fs.mkdirSync(project);
  sessionsDir = path.join(home, ".claude", "projects", project.replace(/[:\\/]/g, "-").toLowerCase());
  fs.mkdirSync(sessionsDir, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.stubEnv("MINDER_STATE_DIR", path.join(root, "state"));
  delete g.__minderInsightsMarks;

  jsonlReads = [];
  const real = realReadFile;
  readSpy = vi.spyOn(fs.promises, "readFile").mockImplementation(((p: fs.PathLike | fs.promises.FileHandle, ...rest: unknown[]) => {
    if (String(p).endsWith(".jsonl")) jsonlReads.push(path.basename(String(p)));
    return (real as (...a: unknown[]) => Promise<string>)(p, ...rest);
  }) as typeof fs.promises.readFile);
});

afterEach(async () => {
  await flushSyncMarks(); // cancels the pending flush timer so it cannot fire inside the next test
  readSpy.mockRestore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete g.__minderInsightsMarks;
  fs.rmSync(root, { recursive: true, force: true });
});

const OLD = Date.parse("2026-09-01T00:00:00Z");

// The sync starts its mark 1 s early (so a file written as it begins is re-read once), and a file's
// ctime is its creation/utimes time (it cannot be backdated). So fixtures must age past that second
// before the scan that is meant to record them.
const settle = () => new Promise<void>((r) => setTimeout(r, 1100));

describe("insights sync watermark (#612)", () => {
  it("does not re-read sessions newer than a stale INSIGHTS.md once they have been looked at", async () => {
    session("a", "alpha insight", OLD);
    await scanInsightsMd(project);
    touchInsights(OLD + 1000); // INSIGHTS.md is now OLDER than "now", like a project that has gone quiet on insights
    // a session written after INSIGHTS.md, containing the SAME insight (so nothing new to append)
    session("b", "alpha insight", Date.now() - 60_000);
    delete g.__minderInsightsMarks; // as if this install predates the marks: only the stale mtime to go on

    jsonlReads = [];
    await settle();
    await scanInsightsMd(project); // reads what is newer than INSIGHTS.md once, finds nothing new, records the sync
    expect([...jsonlReads].sort()).toEqual(["a.jsonl", "b.jsonl"]); // both are newer than the stale INSIGHTS.md (a's ctime is fresh)

    jsonlReads = [];
    await scanInsightsMd(project);
    await scanInsightsMd(project);
    expect(jsonlReads).toEqual([]);
  });

  it("reads a session that changes after the last sync, and appends its new insight", async () => {
    session("a", "alpha insight", OLD);
    await scanInsightsMd(project);
    await scanInsightsMd(project);
    jsonlReads = [];

    session("c", "gamma insight", Date.now() + 5_000);
    const info = await scanInsightsMd(project);
    expect(jsonlReads).toEqual(["c.jsonl"]);
    expect(info?.entries.map((e) => e.content).sort()).toEqual(["alpha insight", "gamma insight"]);
  });

  it("does not re-read sessions of a project that has no insights and so no INSIGHTS.md", async () => {
    session("a", null, Date.now() - 60_000);
    session("b", null, Date.now() - 60_000);
    await settle();
    expect(await scanInsightsMd(project)).toBeUndefined();
    expect(fs.existsSync(path.join(project, "INSIGHTS.md"))).toBe(false);

    jsonlReads = [];
    await scanInsightsMd(project);
    expect(jsonlReads).toEqual([]);
  });

  it("starts over when INSIGHTS.md that existed has been deleted", async () => {
    session("a", "alpha insight", Date.now() - 60_000);
    await scanInsightsMd(project);
    await scanInsightsMd(project);
    fs.rmSync(path.join(project, "INSIGHTS.md"));

    jsonlReads = [];
    const info = await scanInsightsMd(project);
    expect(jsonlReads).toEqual(["a.jsonl"]);
    expect(info?.entries.map((e) => e.content)).toEqual(["alpha insight"]);
  });

  it("does not advance past a session it failed to read", async () => {
    session("a", null, Date.now() - 60_000);
    session("bad", "beta insight", Date.now() - 60_000);
    const real = realReadFile;
    let failBad = true;
    readSpy.mockImplementation(((p: fs.PathLike | fs.promises.FileHandle, ...rest: unknown[]) => {
      if (String(p).endsWith(".jsonl")) jsonlReads.push(path.basename(String(p)));
      if (failBad && String(p).endsWith("bad.jsonl")) return Promise.reject(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
      return (real as (...a: unknown[]) => Promise<string>)(p, ...rest);
    }) as typeof fs.promises.readFile);

    expect(await scanInsightsMd(project)).toBeUndefined();
    failBad = false;
    const info = await scanInsightsMd(project);
    expect(info?.entries.map((e) => e.content)).toEqual(["beta insight"]);
  });

  it("remembers the sync across a restart (marks are persisted)", async () => {
    session("a", null, Date.now() - 60_000);
    await settle();
    await scanInsightsMd(project);
    await flushSyncMarks();
    expect(fs.existsSync(path.join(root, "state", "insights-sync.json"))).toBe(true);

    delete g.__minderInsightsMarks; // a new process
    jsonlReads = [];
    await scanInsightsMd(project);
    expect(jsonlReads).toEqual([]);
  });

  it("ignores a corrupt marks file instead of failing", async () => {
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    fs.writeFileSync(path.join(root, "state", "insights-sync.json"), "{not json");
    session("a", "alpha insight", Date.now() - 60_000);
    const info = await scanInsightsMd(project);
    expect(info?.entries.map((e) => e.content)).toEqual(["alpha insight"]);
  });

  it("reads a transcript that arrives later with an OLD mtime preserved (backup restore, copy)", async () => {
    session("a", null, Date.now() - 60_000);
    await scanInsightsMd(project);
    // restored from a backup: mtime says last month, but the file only now exists here (fresh ctime)
    session("restored", "restored insight", OLD);
    const info = await scanInsightsMd(project);
    expect(info?.entries.map((e) => e.content)).toEqual(["restored insight"]);
  });
});

describe("sync mark bookkeeping (#612)", () => {
  it("ignores a mark from the future instead of hiding every transcript until the clock catches up", () => {
    const now = 1_000_000_000_000;
    expect(watermarkFor(null, { at: now + 3_600_000, insightsMtimeMs: null, dirs: [] }, now)).toBe(0);
    expect(watermarkFor(null, { at: now + 5_000, insightsMtimeMs: null, dirs: [] }, now)).toBe(0); // even slightly ahead: a clock stepped back
    expect(watermarkFor(5, { at: now + 3_600_000, insightsMtimeMs: 5, dirs: [] }, now)).toBe(5);
    expect(watermarkFor(null, { at: now - 1000, insightsMtimeMs: null, dirs: [] }, now)).toBe(now - 1000);
  });

  it("ignores a mark recorded against a different INSIGHTS.md (restored from backup, edited, deleted)", () => {
    const now = 1_000_000_000_000;
    const mark = { at: now - 1000, insightsMtimeMs: 500, dirs: [] };
    expect(watermarkFor(500, mark, now)).toBe(now - 1000); // same file: trusted
    expect(watermarkFor(100, mark, now)).toBe(100); // rolled back to an older copy: back to its mtime
    expect(watermarkFor(null, mark, now)).toBe(0); // deleted: start over
  });

  it("never moves a mark backwards (overlapping scans finish out of order)", async () => {
    const mark = async () => {
      session("a", null, Date.now() - 60_000);
      await settle();
      await scanInsightsMd(project);
    };
    await mark();
    setSyncMark(project, { at: Date.now() - 3_600_000, insightsMtimeMs: null, dirs: [] }); // a stale generation finishing late
    jsonlReads = [];
    await scanInsightsMd(project);
    expect(jsonlReads).toEqual([]);
  });

  it("replaces a future-dated mark after a successful scan instead of re-reading everything until the clock catches up", async () => {
    session("a", null, Date.now() - 60_000);
    setSyncMark(project, { at: Date.now() + 3_600_000, insightsMtimeMs: null, dirs: [] }); // clock rollback / hand edit
    await settle();
    await scanInsightsMd(project); // ignores the bad mark, reads, records a real one
    jsonlReads = [];
    await scanInsightsMd(project);
    expect(jsonlReads).toEqual([]);
  });

  it("reads a transcript directory the last sync never saw, even if its files are older than the mark", async () => {
    const known = sessionsDir;
    const restored = `${sessionsDir}--claude-worktrees-restored`; // a worktree dir mounted into place later
    session("a", null, OLD);
    fs.mkdirSync(restored);
    const text = ["`★ Insight ─────────────────────────────────────`", "restored dir insight", "`─────────────────────────────────────────────────`"].join("\n");
    fs.writeFileSync(path.join(restored, "r.jsonl"), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n");
    fs.utimesSync(path.join(restored, "r.jsonl"), OLD / 1000, OLD / 1000);
    await settle(); // every file's ctime is now older than the mark below
    setSyncMark(project, { at: Date.now(), insightsMtimeMs: null, dirs: [path.basename(known)] });

    jsonlReads = [];
    const info = await scanInsightsMd(project);
    expect(jsonlReads).toEqual(["r.jsonl"]); // the known dir's a.jsonl is skipped, the new dir is read in full
    expect(info?.entries.map((e) => e.content)).toEqual(["restored dir insight"]);
  });

  it("flushes the marks synchronously for shutdown, and never throws when it cannot", async () => {
    session("a", null, Date.now() - 60_000);
    await settle();
    await scanInsightsMd(project);
    flushSyncMarksSync();
    expect(JSON.parse(fs.readFileSync(path.join(root, "state", "insights-sync.json"), "utf-8")).version).toBe(1);

    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    fs.writeFileSync(path.join(root, "state"), "a file where the directory should be");
    expect(() => flushSyncMarksSync()).not.toThrow();
  });

  it("does not let an async flush publish an older snapshot after the shutdown flush", async () => {
    setSyncMark(project, { at: 1000, insightsMtimeMs: null, dirs: ["first"] });
    flushSyncMarksSync();
    setSyncMark(project, { at: 2000, insightsMtimeMs: null, dirs: ["second"] });
    await flushSyncMarks(); // would have rewritten the file with the newer map; sealed by the shutdown flush
    const file = JSON.parse(fs.readFileSync(path.join(root, "state", "insights-sync.json"), "utf-8"));
    expect(Object.values<{ dirs: string[] }>(file.marks).map((m) => m.dirs)).toEqual([["first"]]);
  });

  it("re-reads transcripts when INSIGHTS.md is rolled back to an older copy", async () => {
    session("a", "alpha insight", Date.now() - 60_000);
    await settle();
    await scanInsightsMd(project); // appends INSIGHTS.md and records the mark against its new mtime
    await scanInsightsMd(project);
    jsonlReads = [];
    await scanInsightsMd(project);
    expect(jsonlReads).toEqual([]); // trusted while INSIGHTS.md is the file the mark was made for

    touchInsights(OLD); // restored from a backup: a different (older) file
    jsonlReads = [];
    await scanInsightsMd(project);
    expect(jsonlReads).toEqual(["a.jsonl"]);
  });

  it("records only this project's transcript directories in the mark", async () => {
    session("a", null, Date.now() - 60_000);
    fs.mkdirSync(path.join(path.dirname(sessionsDir), "some-other-project"));
    await scanInsightsMd(project);
    await flushSyncMarks();
    const file = JSON.parse(fs.readFileSync(path.join(root, "state", "insights-sync.json"), "utf-8"));
    expect(Object.values<{ dirs: string[] }>(file.marks).map((m) => m.dirs)).toEqual([[path.basename(sessionsDir)]]);
  });
});
