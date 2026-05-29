import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Like the facets tests, we point os.homedir at a temp dir so we control what
// lives under ~/.claude without touching real user data. The module computes
// its paths at load time, so we vi.resetModules() after spying homedir and
// dynamic-import inside each test.

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-stats-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  await fs.mkdir(path.join(tmpHome, ".claude", "usage-data", "session-meta"), { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function writeStatsCache(data: unknown) {
  await fs.writeFile(path.join(tmpHome, ".claude", "stats-cache.json"), JSON.stringify(data));
}
async function writeStatsCacheRaw(raw: string) {
  await fs.writeFile(path.join(tmpHome, ".claude", "stats-cache.json"), raw);
}
async function writeSessionMeta(sessionId: string, data: unknown) {
  await fs.writeFile(
    path.join(tmpHome, ".claude", "usage-data", "session-meta", `${sessionId}.json`),
    JSON.stringify(data)
  );
}

describe("getStatsCache", () => {
  it("returns null when stats-cache.json is absent", async () => {
    const { getStatsCache } = await import("@/lib/scanner/claudeStats");
    expect(await getStatsCache()).toBeNull();
  });

  it("parses a well-formed stats cache", async () => {
    await writeStatsCache({
      version: 3,
      lastComputedDate: "2026-04-29",
      totalSessions: 1200,
      totalMessages: 50000,
      dailyActivity: [{ date: "2026-02-28", messageCount: 2476, sessionCount: 16, toolCallCount: 924 }],
    });
    const { getStatsCache } = await import("@/lib/scanner/claudeStats");
    const stats = await getStatsCache();
    expect(stats).not.toBeNull();
    expect(stats!.totalSessions).toBe(1200);
    expect(stats!.totalMessages).toBe(50000);
    expect(stats!.lastComputedDate).toBe("2026-04-29");
    expect(stats!.dailyActivity).toHaveLength(1);
    expect(stats!.dailyActivity[0]).toEqual({
      date: "2026-02-28",
      messageCount: 2476,
      sessionCount: 16,
      toolCallCount: 924,
    });
  });

  it("degrades to null on malformed JSON (does NOT throw)", async () => {
    await writeStatsCacheRaw("{not valid json");
    const { getStatsCache } = await import("@/lib/scanner/claudeStats");
    await expect(getStatsCache()).resolves.toBeNull();
  });

  it("drops malformed dailyActivity entries and coerces non-numeric counts", async () => {
    await writeStatsCache({
      totalSessions: 5,
      dailyActivity: [
        { date: "2026-03-01", messageCount: "oops", sessionCount: 2, toolCallCount: 3 },
        { sessionCount: 9 }, // no date → dropped
        { date: "2026-03-02", messageCount: 10, sessionCount: 1, toolCallCount: 4 },
      ],
    });
    const { getStatsCache } = await import("@/lib/scanner/claudeStats");
    const stats = await getStatsCache();
    expect(stats!.dailyActivity).toHaveLength(2);
    expect(stats!.dailyActivity[0]).toEqual({
      date: "2026-03-01",
      messageCount: 0, // "oops" → 0
      sessionCount: 2,
      toolCallCount: 3,
    });
    expect(stats!.totalMessages).toBeUndefined();
  });
});

describe("getSessionMeta", () => {
  it("returns null when the session-meta file is absent", async () => {
    const { getSessionMeta } = await import("@/lib/scanner/claudeStats");
    expect(await getSessionMeta("no-such-session")).toBeNull();
  });

  it("maps the snake_case record to the camelCase shape", async () => {
    await writeSessionMeta("abc-123", {
      session_id: "abc-123",
      project_path: "C:\\dev\\foo",
      duration_minutes: 42,
      git_commits: 3,
      git_pushes: 1,
      lines_added: 120,
      lines_removed: 40,
      files_modified: 7,
      tool_counts: { Bash: 9, Read: 4 },
      tool_error_categories: { timeout: 2, "not-found": 1 },
      uses_mcp: true,
      uses_web_search: false,
      first_prompt: "do the thing",
    });
    const { getSessionMeta } = await import("@/lib/scanner/claudeStats");
    const meta = await getSessionMeta("abc-123");
    expect(meta).not.toBeNull();
    expect(meta!.gitCommits).toBe(3);
    expect(meta!.linesAdded).toBe(120);
    expect(meta!.linesRemoved).toBe(40);
    expect(meta!.filesModified).toBe(7);
    expect(meta!.toolCounts).toEqual({ Bash: 9, Read: 4 });
    expect(meta!.toolErrorCategories).toEqual({ timeout: 2, "not-found": 1 });
    expect(meta!.usesMcp).toBe(true);
    expect(meta!.usesWebSearch).toBe(false);
    expect(meta!.firstPrompt).toBe("do the thing");
  });

  it("falls back to the requested id when session_id is missing", async () => {
    await writeSessionMeta("xyz-9", { duration_minutes: 1 });
    const { getSessionMeta } = await import("@/lib/scanner/claudeStats");
    const meta = await getSessionMeta("xyz-9");
    expect(meta!.sessionId).toBe("xyz-9");
  });

  it("degrades to null on malformed JSON (does NOT throw)", async () => {
    await fs.writeFile(
      path.join(tmpHome, ".claude", "usage-data", "session-meta", "bad.json"),
      "not json"
    );
    const { getSessionMeta } = await import("@/lib/scanner/claudeStats");
    await expect(getSessionMeta("bad")).resolves.toBeNull();
  });
});

describe("crossCheckStats", () => {
  it("reports unavailable with null Claude numbers when stats is null", async () => {
    const { crossCheckStats } = await import("@/lib/scanner/claudeStats");
    const cc = crossCheckStats(null, { sessions: 10, messages: 100 });
    expect(cc.available).toBe(false);
    expect(cc.claudeSessions).toBeNull();
    expect(cc.sessionDriftRatio).toBeNull();
    expect(cc.observedSessions).toBe(10);
  });

  it("computes drift ratios against Claude's totals", async () => {
    const { crossCheckStats } = await import("@/lib/scanner/claudeStats");
    const stats = { totalSessions: 100, totalMessages: 1000, dailyActivity: [] };
    const cc = crossCheckStats(stats, { sessions: 110, messages: 1000 });
    expect(cc.available).toBe(true);
    expect(cc.sessionDriftRatio).toBeCloseTo(0.1, 6); // (110-100)/100
    expect(cc.messageDriftRatio).toBe(0); // exact match
  });

  it("guards divide-by-zero when Claude's count is 0", async () => {
    const { crossCheckStats } = await import("@/lib/scanner/claudeStats");
    const stats = { totalSessions: 0, dailyActivity: [] };
    expect(crossCheckStats(stats, { sessions: 0, messages: 0 }).sessionDriftRatio).toBe(0);
    expect(crossCheckStats(stats, { sessions: 5, messages: 0 }).sessionDriftRatio).toBe(1);
  });
});
