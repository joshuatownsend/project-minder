import { describe, it, expect, beforeEach, vi } from "vitest";
import type { UsageTurn } from "@/lib/usage/types";

// #492 — the memo key for the /api/memory/seed histogram.
//
// The cache is keyed on a corpus fingerprint with NO TTL, so a key that cannot
// see a change means the histogram survives a corpus it no longer describes
// indefinitely. A max-mtime watermark is MONOTONE — it answers "has anything
// newer appeared" and nothing else — so deleting a transcript that does not
// hold the maximum leaves it untouched.
//
// These tests drive the key, not the filesystem: the corpus is whatever the
// mocked parser reports, which is what lets "one file deleted, watermark
// unchanged" be expressed exactly rather than approximated by touching files
// and hoping the mtimes land right. The FILESYSTEM half — that
// `getJsonlFileCount()` tracks the live set — is `retainOnly`'s contract and is
// covered with the cache it belongs to.

const parseAllSessions = vi.fn();
const getJsonlMaxMtime = vi.fn();
const getJsonlFileCount = vi.fn();

vi.mock("@/lib/usage/parser", () => ({
  parseAllSessions: (...a: unknown[]) => parseAllSessions(...a),
  getJsonlMaxMtime: () => getJsonlMaxMtime(),
  getJsonlFileCount: () => getJsonlFileCount(),
}));

function turn(overrides: Partial<UsageTurn> = {}): UsageTurn {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    sessionId: "s1",
    projectSlug: "dev-app",
    projectDirName: "C--dev-app",
    model: "claude-opus-5",
    role: "assistant",
    inputTokens: 10,
    outputTokens: 5,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    source: "claude",
    ...overrides,
  };
}

/** A corpus of `n` single-turn sessions. Turn count is what the histogram sums. */
function corpus(n: number): Map<string, UsageTurn[]> {
  const m = new Map<string, UsageTurn[]>();
  for (let i = 0; i < n; i++) m.set(`s${i}`, [turn({ sessionId: `s${i}` })]);
  return m;
}

function total(map: Map<string, number>): number {
  let sum = 0;
  for (const v of map.values()) sum += v;
  return sum;
}

async function load() {
  const mod = await import("@/lib/memory/seedCategoryCounts");
  mod.invalidateSessionCategoryCounts();
  return mod;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getSessionCategoryCounts memo key (#492)", () => {
  it("reuses the histogram when neither the watermark nor the file count moved", async () => {
    const { getSessionCategoryCounts } = await load();
    parseAllSessions.mockResolvedValue(corpus(3));
    getJsonlMaxMtime.mockReturnValue(1000);
    getJsonlFileCount.mockReturnValue(3);

    const first = await getSessionCategoryCounts();
    // Change the corpus WITHOUT changing the key, to prove the second call is
    // served from the memo rather than recomputed to the same answer by luck.
    parseAllSessions.mockResolvedValue(corpus(99));
    const second = await getSessionCategoryCounts();

    expect(second).toBe(first);
    expect(total(second)).toBe(3);
  });

  it("recomputes when a NON-NEWEST transcript is deleted", async () => {
    // The reported defect. The deleted file did not hold the maximum mtime, so
    // the watermark is byte-identical before and after; only the count moves.
    // A test that deleted the NEWEST file would pass against the old key too.
    const { getSessionCategoryCounts } = await load();
    parseAllSessions.mockResolvedValue(corpus(3));
    getJsonlMaxMtime.mockReturnValue(1000);
    getJsonlFileCount.mockReturnValue(3);
    expect(total(await getSessionCategoryCounts())).toBe(3);

    parseAllSessions.mockResolvedValue(corpus(2));
    getJsonlMaxMtime.mockReturnValue(1000);
    getJsonlFileCount.mockReturnValue(2);

    expect(total(await getSessionCategoryCounts())).toBe(2);
  });

  it("recomputes when a new transcript moves the watermark", async () => {
    const { getSessionCategoryCounts } = await load();
    parseAllSessions.mockResolvedValue(corpus(3));
    getJsonlMaxMtime.mockReturnValue(1000);
    getJsonlFileCount.mockReturnValue(3);
    expect(total(await getSessionCategoryCounts())).toBe(3);

    parseAllSessions.mockResolvedValue(corpus(4));
    getJsonlMaxMtime.mockReturnValue(2000);
    getJsonlFileCount.mockReturnValue(4);

    expect(total(await getSessionCategoryCounts())).toBe(4);
  });

  it("still recomputes after an explicit invalidation", async () => {
    // The enable-an-adapter case, which the fingerprint cannot see: the newly
    // enabled transcripts are older than the newest Claude one AND have not
    // been swept yet, so both halves of the key are unchanged. #490's explicit
    // invalidation is not made redundant by #492's count.
    const mod = await load();
    parseAllSessions.mockResolvedValue(corpus(3));
    getJsonlMaxMtime.mockReturnValue(1000);
    getJsonlFileCount.mockReturnValue(3);
    expect(total(await mod.getSessionCategoryCounts())).toBe(3);

    parseAllSessions.mockResolvedValue(corpus(7));
    mod.invalidateSessionCategoryCounts();

    expect(total(await mod.getSessionCategoryCounts())).toBe(7);
  });

  it("classifies only assistant turns", async () => {
    const { getSessionCategoryCounts } = await load();
    const m = new Map<string, UsageTurn[]>([
      ["s1", [turn({ role: "user" }), turn({ role: "assistant" })]],
    ]);
    parseAllSessions.mockResolvedValue(m);
    getJsonlMaxMtime.mockReturnValue(1);
    getJsonlFileCount.mockReturnValue(1);

    expect(total(await getSessionCategoryCounts())).toBe(1);
  });
});
