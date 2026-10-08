import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { scanInsightsMd } from "@/lib/scanner/insightsMd";
import { flushSyncMarks } from "@/lib/scanner/insightsSyncMarks";

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

afterEach(() => {
  readSpy.mockRestore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete g.__minderInsightsMarks;
  fs.rmSync(root, { recursive: true, force: true });
});

const OLD = Date.parse("2026-09-01T00:00:00Z");

describe("insights sync watermark (#612)", () => {
  it("does not re-read sessions newer than a stale INSIGHTS.md once they have been looked at", async () => {
    session("a", "alpha insight", OLD);
    await scanInsightsMd(project);
    touchInsights(OLD + 1000); // INSIGHTS.md is now OLDER than "now", like a project that has gone quiet on insights
    // a session written after INSIGHTS.md, containing the SAME insight (so nothing new to append)
    session("b", "alpha insight", Date.now() - 60_000);
    delete g.__minderInsightsMarks; // as if this install predates the marks: only the stale mtime to go on

    jsonlReads = [];
    await scanInsightsMd(project); // reads b once, finds nothing new, records the sync
    expect(jsonlReads).toEqual(["b.jsonl"]);

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
});
