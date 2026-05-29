import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "child_process";
import { getLiveProcesses, invalidateClaudeAgentsCache } from "@/lib/claudeAgentsCli";

const execFileMock = vi.mocked(execFile);

/**
 * Stub execFile to return a single canned (stdout, error) outcome. The real
 * promisified signature takes (cmd, args, opts, cb); the callback receives
 * (err, stdout, stderr). We swap the callback's first/second arg based on
 * whether the caller wants success or failure.
 */
function stubExecFile(outcome: { stdout?: string; error?: Error }) {
  execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
    const cb = callback as (err: Error | null, stdout: string, stderr: string) => void;
    if (outcome.error) cb(outcome.error, "", "");
    else cb(null, outcome.stdout ?? "", "");
    return {} as ReturnType<typeof execFile>;
  });
}

describe("getLiveProcesses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateClaudeAgentsCache();
  });

  it("parses well-formed agents --json output", async () => {
    stubExecFile({
      stdout: JSON.stringify([
        {
          pid: 18336,
          cwd: "C:\\dev\\pumpops",
          kind: "interactive",
          startedAt: 1779657427668,
          sessionId: "abc-1",
          status: "busy",
        },
      ]),
    });
    const result = await getLiveProcesses();
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].pid).toBe(18336);
    expect(result![0].sessionId).toBe("abc-1");
  });

  it("preserves the optional `name` field when present", async () => {
    stubExecFile({
      stdout: JSON.stringify([
        {
          pid: 1,
          cwd: "C:\\dev\\foo",
          kind: "interactive",
          startedAt: 1,
          sessionId: "s",
          status: "busy",
          name: "my-named-session",
        },
      ]),
    });
    const result = await getLiveProcesses();
    expect(result![0].name).toBe("my-named-session");
  });

  it("returns [] (NOT null) when CLI reports zero sessions", async () => {
    stubExecFile({ stdout: "[]" });
    const result = await getLiveProcesses();
    expect(result).toEqual([]);
    // [] is the load-bearing "CLI works, apply liveness merge" signal.
    expect(result).not.toBeNull();
  });

  it("returns null when CLI binary fails (ENOENT, timeout, non-zero exit)", async () => {
    stubExecFile({ error: new Error("spawn claude ENOENT") });
    const result = await getLiveProcesses();
    expect(result).toBeNull();
  });

  it("returns null when stdout is not valid JSON", async () => {
    stubExecFile({ stdout: "not json {{{" });
    const result = await getLiveProcesses();
    expect(result).toBeNull();
  });

  it("returns null when parsed JSON is not an array", async () => {
    stubExecFile({ stdout: '{"error": "bad CLI version"}' });
    const result = await getLiveProcesses();
    expect(result).toBeNull();
  });

  it("filters out malformed entries instead of failing the whole call", async () => {
    stubExecFile({
      stdout: JSON.stringify([
        { pid: 1, cwd: "C:\\dev\\a", kind: "interactive", startedAt: 1, sessionId: "ok", status: "busy" },
        { pid: "not-a-number", cwd: "C:\\dev\\b", kind: "interactive", startedAt: 2, sessionId: "bad", status: "busy" },
        null,
        "string-not-object",
      ]),
    });
    const result = await getLiveProcesses();
    expect(result).toHaveLength(1);
    expect(result![0].sessionId).toBe("ok");
  });

  it("caches results across calls within the TTL window", async () => {
    stubExecFile({ stdout: "[]" });
    await getLiveProcesses();
    await getLiveProcesses();
    await getLiveProcesses();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("invalidateClaudeAgentsCache forces a fresh CLI invocation", async () => {
    stubExecFile({ stdout: "[]" });
    await getLiveProcesses();
    invalidateClaudeAgentsCache();
    await getLiveProcesses();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent in-flight calls into a single CLI spawn", async () => {
    stubExecFile({ stdout: "[]" });
    const [a, b, c] = await Promise.all([
      getLiveProcesses(),
      getLiveProcesses(),
      getLiveProcesses(),
    ]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("rejects entries with non-finite startedAt (NaN, Infinity)", async () => {
    // Downstream callers do new Date(startedAt).toISOString() which throws
    // RangeError on NaN/Infinity. The typeguard must reject these before they
    // ever reach the merge loop in liveStatus.ts.
    stubExecFile({
      stdout: JSON.stringify([
        { pid: 1, cwd: "C:\\dev\\a", kind: "interactive", startedAt: NaN, sessionId: "nan", status: "busy" },
        { pid: 2, cwd: "C:\\dev\\b", kind: "interactive", startedAt: Infinity, sessionId: "inf", status: "busy" },
        { pid: 3, cwd: "C:\\dev\\c", kind: "interactive", startedAt: 1779657427668, sessionId: "good", status: "busy" },
      ]),
    });
    const result = await getLiveProcesses();
    expect(result).toHaveLength(1);
    expect(result![0].sessionId).toBe("good");
  });

  it("rejects entries with non-string `name` (number, object)", async () => {
    // Typeguard must validate optional `name` — otherwise a non-string value
    // flows into `processName: string` and renders as `[object Object]` /
    // `42` in tooltips.
    stubExecFile({
      stdout: JSON.stringify([
        { pid: 1, cwd: "C:\\dev\\a", kind: "interactive", startedAt: 1, sessionId: "good-undef", status: "busy" },
        { pid: 2, cwd: "C:\\dev\\b", kind: "interactive", startedAt: 2, sessionId: "bad-num", status: "busy", name: 42 },
        { pid: 3, cwd: "C:\\dev\\c", kind: "interactive", startedAt: 3, sessionId: "bad-obj", status: "busy", name: { foo: 1 } },
        { pid: 4, cwd: "C:\\dev\\d", kind: "interactive", startedAt: 4, sessionId: "good-str", status: "busy", name: "my-session" },
      ]),
    });
    const result = await getLiveProcesses();
    expect(result).toHaveLength(2);
    expect(result!.map((p) => p.sessionId).sort()).toEqual(["good-str", "good-undef"]);
  });

  it("invalidate during in-flight fetch prevents stale cache write", async () => {
    // The .then writes cache only when __claudeAgentsFlight still points to
    // the same flight Promise. After invalidate clears it, the resolving
    // flight must not repopulate the cache. The next call must spawn fresh.
    let resolveCli: ((stdout: string) => void) | null = null;
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const cb = callback as (err: Error | null, stdout: string, stderr: string) => void;
      resolveCli = (stdout: string) => cb(null, stdout, "");
      return {} as ReturnType<typeof execFile>;
    });

    // Start a flight; do NOT await it yet.
    const flight1 = getLiveProcesses();
    invalidateClaudeAgentsCache();
    // Now resolve the in-flight CLI with stale data — its .then should detect
    // the flight slot is cleared and skip the cache write.
    resolveCli!(JSON.stringify([{ pid: 99, cwd: "x", kind: "interactive", startedAt: 1, sessionId: "stale", status: "busy" }]));
    await flight1;

    // Stub a fresh CLI response and call again — should spawn a NEW exec,
    // not return the in-flight's stale result from cache.
    stubExecFile({ stdout: "[]" });
    const result2 = await getLiveProcesses();
    expect(result2).toEqual([]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("measures TTL from sample time (fetch start), not cache-write time (#153)", async () => {
    // A slow CLI call must not grant itself extra freshness. cachedAt is
    // stamped at the moment the fetch STARTS (when the process table was
    // sampled), so a 4s fetch + 7s wait = 11s of staleness > 10s TTL and
    // triggers a re-fetch — even though the cache was only *written* 7s ago.
    vi.useFakeTimers();
    try {
      // Deferred callback: capture it now, invoke it after advancing the clock
      // to simulate a fetch that takes 4s of wall time to resolve.
      let resolveCli: ((stdout: string) => void) | null = null;
      execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
        const cb = callback as (err: Error | null, stdout: string, stderr: string) => void;
        resolveCli = (stdout: string) => cb(null, stdout, "");
        return {} as ReturnType<typeof execFile>;
      });

      const flight = getLiveProcesses(); // sampledAt = t0
      vi.advanceTimersByTime(4_000); // fetch takes 4s
      resolveCli!("[]");
      const first = await flight;
      expect(first).toEqual([]);
      expect(execFileMock).toHaveBeenCalledTimes(1);

      // 7s later: total staleness from sample = 4 + 7 = 11s > 10s TTL.
      // If cachedAt had been stamped at resolve time (t=4s), this would read as
      // only 7s old and wrongly serve from cache.
      vi.advanceTimersByTime(7_000);
      stubExecFile({ stdout: "[]" });
      await getLiveProcesses();
      expect(execFileMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches null results for a shorter TTL than success results", async () => {
    // Negative-result TTL is 1 s; success TTL is 10 s. A single failed call
    // must NOT lock the dashboard into CLI-unavailable mode for the full 10 s.
    vi.useFakeTimers();
    try {
      stubExecFile({ error: new Error("spawn claude ENOENT") });
      const first = await getLiveProcesses();
      expect(first).toBeNull();
      expect(execFileMock).toHaveBeenCalledTimes(1);

      // Within negative-result TTL window: served from cache, no respawn.
      vi.advanceTimersByTime(500);
      await getLiveProcesses();
      expect(execFileMock).toHaveBeenCalledTimes(1);

      // After negative-result TTL but still inside success TTL: respawn.
      vi.advanceTimersByTime(1_500);
      stubExecFile({ stdout: "[]" });
      const recovered = await getLiveProcesses();
      expect(recovered).toEqual([]);
      expect(execFileMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
