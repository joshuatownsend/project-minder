import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "fs";
import os from "os";
import path from "path";

// readHistory parses ~/.claude/history.jsonl incrementally (#690): only the
// bytes appended since the last read. Real files, no fs mock.

let home: string;
let readHistory: typeof import("@/lib/scanner/claudeSessions").readHistory;

const entry = (project: string, display: string) => JSON.stringify({ project, display }) + "\n";
const displays = (map: Map<string, Array<{ display?: string }>>) =>
  [...map.values()].flat().map((e) => e.display).sort();

beforeEach(async () => {
  vi.resetModules(); // fresh per-home parse state
  delete (globalThis as Record<string, unknown>).__minderHistoryParses;
  delete (globalThis as Record<string, unknown>).__minderHistoryReads;
  ({ readHistory } = await import("@/lib/scanner/claudeSessions"));
  home = mkdtempSync(path.join(os.tmpdir(), "pm-history-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("readHistory — incremental parse of history.jsonl (#690)", () => {
  it("adds appended lines without re-adding the ones already parsed", async () => {
    const file = path.join(home, "history.jsonl");
    writeFileSync(file, entry("C:\\dev\\a", "one") + entry("C:\\dev\\b", "two"));
    expect(displays(await readHistory(home, []))).toEqual(["one", "two"]);

    appendFileSync(file, entry("C:\\dev\\a", "three"));
    expect(displays(await readHistory(home, []))).toEqual(["one", "three", "two"]);
    // Nothing new: same answer, no duplicates.
    expect(displays(await readHistory(home, []))).toEqual(["one", "three", "two"]);
  });

  it("waits for a half-written line to be finished instead of dropping or duplicating it", async () => {
    const file = path.join(home, "history.jsonl");
    const full = entry("C:\\dev\\a", "later");
    writeFileSync(file, entry("C:\\dev\\a", "first") + full.slice(0, 10));
    expect(displays(await readHistory(home, []))).toEqual(["first"]);

    appendFileSync(file, full.slice(10));
    expect(displays(await readHistory(home, []))).toEqual(["first", "later"]);
  });

  it("counts a complete last entry written without a trailing newline", async () => {
    writeFileSync(path.join(home, "history.jsonl"), entry("C:\\dev\\a", "one") + JSON.stringify({ project: "C:\\dev\\a", display: "two" }));
    expect(displays(await readHistory(home, []))).toEqual(["one", "two"]);
  });

  it("starts over when the file shrinks", async () => {
    const file = path.join(home, "history.jsonl");
    writeFileSync(file, entry("C:\\dev\\a", "old-1") + entry("C:\\dev\\a", "old-2"));
    await readHistory(home, []);
    writeFileSync(file, entry("C:\\dev\\a", "new"));
    expect(displays(await readHistory(home, []))).toEqual(["new"]);
  });

  it("starts over when the path mappings change", async () => {
    writeFileSync(path.join(home, "history.jsonl"), entry("/home/josh/dev/x", "wsl"));
    const plain = await readHistory(home, []);
    expect([...plain.keys()].some((k) => k.includes("/home/josh/dev/x"))).toBe(true);

    const mapped = await readHistory(home, [{ from: "/home/josh", to: "\\\\wsl.localhost\\Ubuntu\\home\\josh" }] as never);
    expect([...mapped.keys()].some((k) => k.includes("wsl.localhost"))).toBe(true);
    expect(displays(mapped)).toEqual(["wsl"]);
  });

  it("concurrent reads after an append add each new entry once (Codex review, PR #701)", async () => {
    const file = path.join(home, "history.jsonl");
    writeFileSync(file, entry("C:\\dev\\a", "one"));
    await readHistory(home, []);
    appendFileSync(file, entry("C:\\dev\\a", "two"));
    const results = await Promise.all(Array.from({ length: 10 }, () => readHistory(home, [])));
    for (const map of results) expect(displays(map)).toEqual(["one", "two"]);
  });

  it("returns an empty map when the home has no history file", async () => {
    expect((await readHistory(home, [])).size).toBe(0);
  });
});
