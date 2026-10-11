import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fsSync, { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "fs";

// #672: the live-status build stats only the transcripts the index can't rule
// out. Pins the wiring: a transcript the filter skips is never stat'ed (unless
// its session is CLI-alive), and with no filter every transcript is.

const mocks = vi.hoisted(() => ({
  filter: null as null | { mustStat: (p: string) => boolean },
  live: [] as Array<{ sessionId: string; pid: number; startedAt: number }>,
}));

vi.mock("@/lib/data/indexedTranscriptFilter", () => ({
  indexedTranscriptFilter: vi.fn(async () => mocks.filter),
}));
vi.mock("@/lib/claudeAgentsCli", () => ({
  getLiveProcesses: vi.fn(async () => mocks.live),
}));

import { getLiveStatusPayload, invalidateLiveStatusCache } from "@/lib/liveStatus";

let home: string;
let dir: string;

function transcript(name: string, ageMs: number): string {
  const file = path.join(dir, `${name}.jsonl`);
  writeFileSync(file, "{}\n");
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(file, t, t);
  return file;
}

const HOUR = 3_600_000;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "pm-live-status-"));
  dir = path.join(home, ".claude", "projects", "C--dev-x");
  mkdirSync(dir, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(home);
  invalidateLiveStatusCache();
  mocks.filter = null;
  mocks.live = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function statted(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c) => path.basename(String(c[0]), ".jsonl")).sort();
}

describe("live status stat filter (#672)", () => {
  it("never stats a transcript the index rules out", async () => {
    const recent = transcript("recent", HOUR);
    transcript("old", 30 * HOUR);
    const fresh = transcript("fresh", 1_000);
    mocks.filter = { mustStat: (p) => p === recent || p === fresh };
    const stat = vi.spyOn(fsSync.promises, "stat");

    const { sessions } = await getLiveStatusPayload();

    expect(statted(stat)).toEqual(["fresh", "recent"]);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(["fresh", "recent"]);
  });

  it("still stats a ruled-out transcript whose session the CLI reports alive", async () => {
    transcript("resumed", 30 * HOUR);
    mocks.filter = { mustStat: () => false };
    mocks.live = [{ sessionId: "resumed", pid: 42, startedAt: Date.now() }];
    const stat = vi.spyOn(fsSync.promises, "stat");

    const { sessions } = await getLiveStatusPayload();

    expect(statted(stat)).toEqual(["resumed"]);
    expect(sessions.map((s) => s.sessionId)).toEqual(["resumed"]);
  });

  it("stats every transcript when there is no index to ask", async () => {
    transcript("a", HOUR);
    transcript("b", 30 * HOUR);
    const stat = vi.spyOn(fsSync.promises, "stat");

    const { sessions } = await getLiveStatusPayload();

    expect(statted(stat)).toEqual(["a", "b"]);
    expect(sessions.map((s) => s.sessionId)).toEqual(["a"]);
  });
});
