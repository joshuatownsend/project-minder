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
