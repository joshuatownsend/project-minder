import { describe, it, expect, vi, beforeEach } from "vitest";

// git.ts does `const execFileAsync = promisify(execFile)` at module load, so
// the mocked execFile needs a `util.promisify.custom` implementation
// resolving to `{stdout, stderr}` — otherwise Node's generic promisify
// fallback resolves to a positional array and `const { stdout } = await
// execFileAsync(...)` silently destructures `undefined`. Same pattern as
// tests/emergencyStop.test.ts.
const { execFileMock, execFileAsyncMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { promisify } = require("util") as typeof import("util");
  const asyncFn = vi.fn();
  const fn = vi.fn() as ReturnType<typeof vi.fn> & { [key: symbol]: unknown };
  fn[promisify.custom] = asyncFn;
  return { execFileMock: fn, execFileAsyncMock: asyncFn };
});

vi.mock("child_process", () => ({ execFile: execFileMock }));

import {
  filterCommitsInInterval,
  scanGit,
  scanGitDirtyStatus,
  runGitChecked,
} from "@/lib/scanner/git";
import type { CommitMeta } from "@/lib/scanner/git";

/**
 * Queue canned results for successive execFileAsync("git", ...) calls made
 * inside git.ts (runGit/runGitChecked call execFile in the order the
 * production code issues them). Each entry is either a string (stdout,
 * success) or an Error (the call rejects).
 */
function stubGitCalls(results: Array<string | Error>) {
  let call = 0;
  execFileAsyncMock.mockImplementation(() => {
    const next = results[call++];
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({ stdout: next ?? "", stderr: "" });
  });
}

function commit(date: string, subject = "msg"): CommitMeta {
  return { sha: "abc123", date, subject };
}

const T1 = "2026-01-01T00:00:00.000Z"; // 1735689600000
const T2 = "2026-01-02T00:00:00.000Z"; // 1735776000000
const T3 = "2026-01-03T00:00:00.000Z"; // 1735862400000
const T4 = "2026-01-04T00:00:00.000Z"; // 1735948800000

const startMs = new Date(T2).getTime();
const endMs = new Date(T3).getTime();

describe("filterCommitsInInterval", () => {
  it("returns empty array when given no commits", () => {
    expect(filterCommitsInInterval([], startMs, endMs)).toHaveLength(0);
  });

  it("includes commits exactly on the start boundary (inclusive)", () => {
    const result = filterCommitsInInterval([commit(T2)], startMs, endMs);
    expect(result).toHaveLength(1);
  });

  it("includes commits exactly on the end boundary (inclusive)", () => {
    const result = filterCommitsInInterval([commit(T3)], startMs, endMs);
    expect(result).toHaveLength(1);
  });

  it("excludes commits before the start boundary", () => {
    const result = filterCommitsInInterval([commit(T1)], startMs, endMs);
    expect(result).toHaveLength(0);
  });

  it("excludes commits after the end boundary", () => {
    const result = filterCommitsInInterval([commit(T4)], startMs, endMs);
    expect(result).toHaveLength(0);
  });

  it("filters mixed commits correctly", () => {
    const commits = [commit(T1), commit(T2), commit(T3), commit(T4)];
    const result = filterCommitsInInterval(commits, startMs, endMs);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.date)).toEqual([T2, T3]);
  });

  it("preserves commit fields on matching entries", () => {
    const c = { sha: "deadbeef", date: T2, subject: "feat: add thing" };
    const result = filterCommitsInInterval([c], startMs, endMs);
    expect(result[0]).toEqual(c);
  });

  it("returns empty when interval is zero-width and no commit matches exact ms", () => {
    const midMs = startMs + 1000;
    const result = filterCommitsInInterval([commit(T2)], midMs, midMs);
    expect(result).toHaveLength(0);
  });

  it("returns single commit when interval is zero-width and commit matches exactly", () => {
    const result = filterCommitsInInterval([commit(T2)], startMs, startMs);
    expect(result).toHaveLength(1);
  });
});

describe("scanGit — detached HEAD fallback (B4)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("falls back to a short SHA and still populates commit/remote when branch --show-current is empty", async () => {
    // Call order: branch --show-current ("" = detached) -> rev-parse --short
    // HEAD (fallback label) -> log -1 (commit meta) -> remote get-url origin.
    stubGitCalls([
      "",
      "abc1234",
      "2026-01-01T00:00:00+00:00|||Initial commit",
      "https://github.com/user/repo.git",
    ]);

    const info = await scanGit("C:\\dev\\detached-repo");

    expect(info).toBeDefined();
    expect(info?.branch).toBe("abc1234");
    expect(info?.lastCommitDate).toBe("2026-01-01T00:00:00+00:00");
    expect(info?.lastCommitMessage).toBe("Initial commit");
    expect(info?.remoteUrl).toBe("https://github.com/user/repo");
  });

  it("returns undefined when neither branch nor a short SHA resolve (not a git repo)", async () => {
    stubGitCalls(["", ""]);
    const info = await scanGit("C:\\dev\\not-a-repo");
    expect(info).toBeUndefined();
  });

  it("still uses the real branch name when show-current succeeds (regression guard)", async () => {
    stubGitCalls([
      "main",
      "2026-01-01T00:00:00+00:00|||Initial commit",
      "https://github.com/user/repo.git",
    ]);
    const info = await scanGit("C:\\dev\\normal-repo");
    expect(info?.branch).toBe("main");
  });
});

describe("scanGitDirtyStatus — exec failure is unknown, not clean (B5)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports isDirty:false with no unknown flag when git succeeds with empty output (genuinely clean)", async () => {
    stubGitCalls([""]);
    const status = await scanGitDirtyStatus("C:\\dev\\clean-repo");
    expect(status).toEqual({ isDirty: false, uncommittedCount: 0 });
    expect(status.unknown).toBeUndefined();
  });

  it("reports dirty files when git succeeds with porcelain output", async () => {
    stubGitCalls([" M file.txt\n?? new.txt"]);
    const status = await scanGitDirtyStatus("C:\\dev\\dirty-repo");
    expect(status.isDirty).toBe(true);
    expect(status.uncommittedCount).toBe(2);
    expect(status.unknown).toBeUndefined();
  });

  it("reports unknown:true (not isDirty:false as clean) when the git invocation fails", async () => {
    stubGitCalls([new Error("spawn git ENOENT")]);
    const status = await scanGitDirtyStatus("C:\\dev\\broken-repo");
    expect(status.unknown).toBe(true);
    // isDirty stays false (no dirty files known), but callers must check
    // `unknown` before treating this as a confirmed-clean repo.
    expect(status.isDirty).toBe(false);
  });
});

describe("runGitChecked — distinguishes exec failure from empty stdout", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns ok:true with trimmed stdout on success", async () => {
    stubGitCalls(["  hello  \n"]);
    const result = await runGitChecked(["status"], "C:\\dev\\repo");
    expect(result).toEqual({ ok: true, stdout: "hello" });
  });

  it("returns ok:false on exec failure", async () => {
    stubGitCalls([new Error("boom")]);
    const result = await runGitChecked(["status"], "C:\\dev\\repo");
    expect(result).toEqual({ ok: false, stdout: "" });
  });
});
