/**
 * #473 — `scanAllSessions` per-file cache.
 *
 * The issue is a performance one, but the risk it introduces is a correctness
 * one, and that is what this file pins. A `SessionSummary` is not a pure
 * function of its transcript: `status` and `isActive` also depend on the clock,
 * and they change precisely when the FILE STOPS CHANGING — an abandoned tool
 * call decays `working` → `needs_attention` → `idle` while its transcript sits
 * untouched. So an mtime-keyed cache that stored the composed summary would pin
 * every session to the status it held the first time it was read, and the
 * sessions it would be wrong about are exactly the ones the status field exists
 * to flag.
 *
 * `costEstimate` is the same defect one input over, and was found in review:
 * it depends on the active pricing table, which is likewise not in the cache
 * key, so editing a rule in Settings would leave every already-scanned session
 * priced at the old rates.
 *
 * Hence the split in `sessionStatus.ts` and `applyLiveFields` in the scanner:
 * what the transcript determines is cached, what outside state determines is
 * recomputed per read. The tests below fail if anyone later "simplifies" that
 * away by returning the cached summary verbatim.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-scan-cache-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  vi.resetModules();
  // The cache lives on `globalThis`, so `resetModules` does NOT clear it and a
  // previous test file's entries would otherwise survive into this one.
  const { clearSessionScanCache } = await import("@/lib/scanner/claudeConversations");
  clearSessionScanCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function sessionDir(dirName: string) {
  return path.join(tmpHome, ".claude", "projects", dirName);
}

async function writeSession(dirName: string, sessionId: string, lines: object[]) {
  const dir = sessionDir(dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
  );
}

function user(ts: string, text: string) {
  return {
    type: "user",
    timestamp: ts,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantText(ts: string) {
  return {
    type: "assistant",
    timestamp: ts,
    message: {
      model: "claude-opus-5",
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

/** An assistant turn that calls a tool and never receives a `tool_result`. */
function assistantPendingTool(ts: string, id: string) {
  return {
    type: "assistant",
    timestamp: ts,
    message: {
      model: "claude-opus-5",
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

/** Force a file's mtime, so "how stale is this session" is under test control. */
async function setMtime(filePath: string, ageMs: number) {
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, when, when);
}

describe("#473 — session scan cache re-derives clock-dependent fields", () => {
  it("decays a cached working session to idle as its unresolved tool call ages", async () => {
    await writeSession("C--dev-demo", "sess-pending", [
      user("2026-08-01T10:00:00Z", "run it"),
      assistantPendingTool("2026-08-01T10:00:01Z", "tool-1"),
    ]);
    const file = path.join(sessionDir("C--dev-demo"), "sess-pending.jsonl");
    // Fresh write → under the 90s WORKING_MS threshold.
    await setMtime(file, 5_000);

    const mod = await import("@/lib/scanner/claudeConversations");
    const cold = (await mod.scanAllSessions()).find((s) => s.sessionId === "sess-pending");
    expect(cold?.status).toBe("working");
    expect(cold?.isActive).toBe(true);

    // Advance the clock WITHOUT touching the file: mtime and size are both
    // unchanged, so the second sweep is a pure cache hit. Anything that comes
    // back stale here came back from the cache un-recomputed.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 20 * 60_000);

    const warm = (await mod.scanAllSessions()).find((s) => s.sessionId === "sess-pending");
    expect(warm?.status).toBe("idle"); // past STALE_MS — abandoned, not working
    expect(warm?.isActive).toBe(false);
  });

  it("crosses working → needs_attention on a cache hit", async () => {
    // The middle band, which a boolean "fresh or not" cache would also miss:
    // three outcomes ride the same cached `hasPendingTools`.
    await writeSession("C--dev-demo", "sess-mid", [
      user("2026-08-01T10:00:00Z", "run it"),
      assistantPendingTool("2026-08-01T10:00:01Z", "tool-1"),
    ]);
    await setMtime(path.join(sessionDir("C--dev-demo"), "sess-mid.jsonl"), 5_000);

    const mod = await import("@/lib/scanner/claudeConversations");
    expect(
      (await mod.scanAllSessions()).find((s) => s.sessionId === "sess-mid")?.status
    ).toBe("working");

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3 * 60_000); // > 90s, < 10min

    expect(
      (await mod.scanAllSessions()).find((s) => s.sessionId === "sess-mid")?.status
    ).toBe("needs_attention");
  });

  it("leaves a resolved session idle in both passes", async () => {
    // The counterpart: `hasPendingTools === false` must stay `idle` regardless
    // of age, so the test above cannot pass merely by making everything idle.
    await writeSession("C--dev-demo", "sess-done", [
      user("2026-08-01T10:00:00Z", "hi"),
      assistantText("2026-08-01T10:00:01Z"),
    ]);
    await setMtime(path.join(sessionDir("C--dev-demo"), "sess-done.jsonl"), 5_000);

    const mod = await import("@/lib/scanner/claudeConversations");
    const cold = (await mod.scanAllSessions()).find((s) => s.sessionId === "sess-done");
    expect(cold?.status).toBe("idle");
    expect(cold?.isActive).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 20 * 60_000);

    const warm = (await mod.scanAllSessions()).find((s) => s.sessionId === "sess-done");
    expect(warm?.status).toBe("idle");
    expect(warm?.isActive).toBe(false);
  });
});

describe("#473 — session scan cache re-derives cost from live pricing", () => {
  it("picks up a pricing-rule change on a cache hit", async () => {
    // The same defect as the status one, one input over: a transcript's cost
    // depends on the active pricing table, which is not part of the cache key.
    // Editing a rule in Settings changes what a session costs without changing
    // one byte of it, so a cached `costEstimate` would survive the edit until
    // the file was appended to, evicted, or the process restarted. Uncached,
    // this recomputed on every sweep — caching it was a regression this PR
    // introduced. (Codex P2, PR #494.)
    await writeSession("C--dev-demo", "sess-cost", [
      user("2026-08-01T10:00:00Z", "hi"),
      assistantText("2026-08-01T10:00:01Z"),
    ]);

    const mod = await import("@/lib/scanner/claudeConversations");
    const { setPricingRules } = await import("@/lib/usage/costCalculator");

    setPricingRules([
      { pattern: "claude-opus-5", inputUsdPerMillion: 12, outputUsdPerMillion: 60 },
    ]);
    const first = (await mod.scanAllSessions()).find((s) => s.sessionId === "sess-cost");
    expect(first?.costEstimate).toBeGreaterThan(0);

    // Same file, untouched — the second sweep is a pure cache hit.
    setPricingRules([
      { pattern: "claude-opus-5", inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    ]);
    const second = (await mod.scanAllSessions()).find((s) => s.sessionId === "sess-cost");
    expect(second?.costEstimate).toBe(0);

    // And back up again, so this cannot pass by any mechanism that only ever
    // drives cost toward zero.
    setPricingRules([
      { pattern: "claude-opus-5", inputUsdPerMillion: 24, outputUsdPerMillion: 120 },
    ]);
    const third = (await mod.scanAllSessions()).find((s) => s.sessionId === "sess-cost");
    expect(third?.costEstimate).toBeGreaterThan(first!.costEstimate);

    setPricingRules([]);
  });
});

describe("#473 — session scan cache reuse", () => {
  it("does not re-read an unchanged transcript, and does re-read a changed one", async () => {
    await writeSession("C--dev-demo", "sess-reuse", [
      user("2026-08-01T10:00:00Z", "one"),
      assistantText("2026-08-01T10:00:01Z"),
    ]);
    const file = path.join(sessionDir("C--dev-demo"), "sess-reuse.jsonl");

    const mod = await import("@/lib/scanner/claudeConversations");
    const cold = (await mod.scanAllSessions()).find((s) => s.sessionId === "sess-reuse");
    expect(cold?.userMessageCount).toBe(1);

    // Counting `readFile` calls is the only observation that distinguishes "the
    // cache exists" from "the cache is used" — #472's cache was present and
    // doing nothing, which is the failure this assertion exists to prevent.
    const readSpy = vi.spyOn(fs, "readFile");
    const warm = (await mod.scanAllSessions()).find((s) => s.sessionId === "sess-reuse");
    expect(readSpy).not.toHaveBeenCalledWith(file, "utf-8");
    expect(warm?.userMessageCount).toBe(1);
    readSpy.mockRestore();

    // Appending changes both mtime and size, so the next sweep must re-parse.
    await fs.appendFile(
      file,
      JSON.stringify(user("2026-08-01T10:05:00Z", "two")) + "\n"
    );
    const after = (await mod.scanAllSessions()).find((s) => s.sessionId === "sess-reuse");
    expect(after?.userMessageCount).toBe(2);
  });

  it("does not cache a transient read failure as 'not a session'", async () => {
    // `null` is cached, which is what keeps a 60MB transcript cheap. That is
    // only safe while `null` means "the bytes were read and this is not a
    // session". If an EACCES/EBUSY/EIO from `readFile` were laundered into the
    // same `null`, the failure would become permanent: restoring permissions
    // touches ctime, not mtime or size, so the cache key is unchanged and the
    // session would stay hidden until its contents changed or the process
    // restarted. Uncached, the error cost exactly one sweep — and this test
    // pins that it still does. (Codex P2, PR #494.)
    await writeSession("C--dev-demo", "sess-locked", [
      user("2026-08-01T10:00:00Z", "hi"),
      assistantText("2026-08-01T10:00:01Z"),
    ]);
    const file = path.join(sessionDir("C--dev-demo"), "sess-locked.jsonl");

    const mod = await import("@/lib/scanner/claudeConversations");

    const real = fs.readFile;
    const spy = vi.spyOn(fs, "readFile").mockImplementation((async (
      p: Parameters<typeof fs.readFile>[0],
      ...rest: unknown[]
    ) => {
      if (p === file) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (real as never as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);

    const blocked = await mod.scanAllSessions();
    expect(blocked.find((s) => s.sessionId === "sess-locked")).toBeUndefined();
    // Nothing was cached, so there is no verdict to evict.
    expect(mod.sessionScanCacheSize()).toBe(0);

    // Permission restored. The FILE IS NOT TOUCHED — mtime and size are exactly
    // what they were during the failed sweep, so a cached `null` would survive.
    spy.mockRestore();

    const after = await mod.scanAllSessions();
    expect(after.find((s) => s.sessionId === "sess-locked")).toBeDefined();
  });

  it("evicts a transcript that disappeared between sweeps", async () => {
    await writeSession("C--dev-demo", "sess-gone", [
      user("2026-08-01T10:00:00Z", "one"),
      assistantText("2026-08-01T10:00:01Z"),
    ]);
    await writeSession("C--dev-demo", "sess-stays", [
      user("2026-08-01T11:00:00Z", "two"),
      assistantText("2026-08-01T11:00:01Z"),
    ]);

    const mod = await import("@/lib/scanner/claudeConversations");
    expect((await mod.scanAllSessions()).map((s) => s.sessionId).sort()).toEqual([
      "sess-gone",
      "sess-stays",
    ]);

    expect(mod.sessionScanCacheSize()).toBe(2);

    await fs.rm(path.join(sessionDir("C--dev-demo"), "sess-gone.jsonl"));

    const after = await mod.scanAllSessions();
    expect(after.map((s) => s.sessionId)).toEqual(["sess-stays"]);
    // The returned list above cannot tell an evicting cache from a hoarding
    // one — `readdir` stops reporting a deleted file either way, so that
    // assertion passes with `retainOnly` removed entirely (verified by
    // mutation). The cache's own size is the only thing that discriminates,
    // and it must be 1, not 0: a `retainOnly` scoped per-home rather than per
    // sweep would take `sess-stays` with it.
    expect(mod.sessionScanCacheSize()).toBe(1);
  });
});
