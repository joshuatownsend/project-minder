import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the gh subprocess and the git helpers the cache reuses. execFile is
// callback-style; the cache's ghJson wrapper invokes it as
// execFile("gh", args, options, callback).
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("@/lib/scanner/git", () => ({
  runGit: vi.fn(),
  detectMainBranch: vi.fn(),
}));

import { execFile } from "child_process";
import { runGit, detectMainBranch } from "@/lib/scanner/git";
import { githubActivityCache } from "@/lib/githubActivityCache";

const mockExecFile = vi.mocked(execFile);
const mockRunGit = vi.mocked(runGit);
const mockDetectMainBranch = vi.mocked(detectMainBranch);

type Cb = (err: unknown, stdout: string, stderr: string) => void;

/** Configure the execFile mock to dispatch on the gh subcommand. Each value
 *  is either a JSON-serializable payload (success) or an Error-like object
 *  with optional `code`/`stderr` (failure). */
function setGh(opts: {
  pr?: unknown | { __error: { code?: string | number; stderr?: string } };
  run?: unknown | { __error: { code?: string | number; stderr?: string } };
  repo?: unknown | { __error: { code?: string | number; stderr?: string } };
}) {
  mockExecFile.mockImplementation(((
    _file: string,
    args: string[],
    _options: unknown,
    cb: Cb
  ) => {
    let value: unknown;
    if (args.includes("pr")) value = opts.pr;
    else if (args.includes("run")) value = opts.run;
    else value = opts.repo;

    if (value && typeof value === "object" && "__error" in (value as object)) {
      const e = (value as { __error: { code?: string | number; stderr?: string } }).__error;
      const err = Object.assign(new Error("gh failed"), { code: e.code });
      cb(err, "", e.stderr ?? "");
      return;
    }
    cb(null, JSON.stringify(value ?? []), "");
  }) as unknown as typeof execFile);
}

/** Flush microtasks + a few macrotask turns so the awaited fetchActivity
 *  chain (runGit/detectMainBranch + up to 3 execFile callbacks) settles. */
async function flush() {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  githubActivityCache.dispose();
  vi.clearAllMocks();
  mockDetectMainBranch.mockResolvedValue("main");
  mockRunGit.mockResolvedValue("");
});

describe("githubActivityCache.fetchActivity (happy path)", () => {
  it("returns available:true with PRs, passing CI, and lastPushAt", async () => {
    setGh({
      pr: [
        {
          number: 7,
          title: "Add feature",
          url: "https://github.com/o/r/pull/7",
          isDraft: false,
          headRefName: "feature",
          updatedAt: "2026-06-20T00:00:00Z",
        },
        {
          number: 8,
          title: "Fix bug",
          url: "https://github.com/o/r/pull/8",
          isDraft: true,
          headRefName: "fix",
          updatedAt: "2026-06-21T00:00:00Z",
        },
      ],
      run: [
        {
          status: "completed",
          conclusion: "success",
          workflowName: "CI",
          url: "https://github.com/o/r/actions/runs/1",
        },
      ],
      repo: { pushedAt: "2026-06-22T00:00:00Z" },
    });

    githubActivityCache.enqueue([
      { slug: "o-r", path: "C:\\dev\\o-r", remoteUrl: "git@github.com:o/r.git" },
    ]);
    await flush();

    const a = githubActivityCache.get("o-r");
    expect(a?.available).toBe(true);
    expect(a?.repo).toBe("o/r");
    expect(a?.openPrCount).toBe(2);
    expect(a?.prs?.[1]).toMatchObject({ number: 8, isDraft: true });
    expect(a?.ci?.status).toBe("passing");
    expect(a?.ci?.workflowName).toBe("CI");
    expect(a?.lastPushAt).toBe("2026-06-22T00:00:00Z");
    expect(typeof a?.checkedAt).toBe("number");
  });

  it("uses an array of args with `-R owner/repo` exactly (P2 arg-safety regression)", async () => {
    setGh({ pr: [], run: [], repo: { pushedAt: "2026-01-01T00:00:00Z" } });

    githubActivityCache.enqueue([
      { slug: "o-r", path: "C:\\dev\\o-r", remoteUrl: "https://github.com/o/r" },
    ]);
    await flush();

    // Every call goes to "gh" with an array; the -R value is exactly owner/repo.
    for (const call of mockExecFile.mock.calls) {
      expect(call[0]).toBe("gh");
      const args = call[1] as string[];
      expect(Array.isArray(args)).toBe(true);
      const i = args.indexOf("-R");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(args[i + 1]).toBe("o/r");
    }
  });
});

describe("githubActivityCache CI mapping", () => {
  it("maps conclusion:failure → failing (still available:true)", async () => {
    setGh({
      pr: [],
      run: [{ status: "completed", conclusion: "failure", workflowName: "CI" }],
      repo: {},
    });
    githubActivityCache.enqueue([
      { slug: "x", path: "C:\\dev\\x", remoteUrl: "https://github.com/o/r" },
    ]);
    await flush();
    const a = githubActivityCache.get("x");
    expect(a?.available).toBe(true);
    expect(a?.ci?.status).toBe("failing");
  });

  it("maps status:in_progress, conclusion:null → pending", async () => {
    setGh({
      pr: [],
      run: [{ status: "in_progress", conclusion: null }],
      repo: {},
    });
    githubActivityCache.enqueue([
      { slug: "x", path: "C:\\dev\\x", remoteUrl: "https://github.com/o/r" },
    ]);
    await flush();
    expect(githubActivityCache.get("x")?.ci?.status).toBe("pending");
  });

  it("empty run list → ci.status unknown (still available:true)", async () => {
    setGh({ pr: [], run: [], repo: {} });
    githubActivityCache.enqueue([
      { slug: "x", path: "C:\\dev\\x", remoteUrl: "https://github.com/o/r" },
    ]);
    await flush();
    const a = githubActivityCache.get("x");
    expect(a?.available).toBe(true);
    expect(a?.ci?.status).toBe("unknown");
  });
});

describe("githubActivityCache defensive failure classification", () => {
  it("gh missing (ENOENT) → reason gh-not-installed AND result is cached (no re-spawn)", async () => {
    setGh({ pr: { __error: { code: "ENOENT" } } });
    githubActivityCache.enqueue([
      { slug: "x", path: "C:\\dev\\x", remoteUrl: "https://github.com/o/r" },
    ]);
    await flush();

    const a = githubActivityCache.get("x");
    expect(a?.available).toBe(false);
    expect(a?.reason).toBe("gh-not-installed");

    const callsAfterFirst = mockExecFile.mock.calls.length;
    // Second enqueue within TTL must NOT re-shell gh.
    githubActivityCache.enqueue([
      { slug: "x", path: "C:\\dev\\x", remoteUrl: "https://github.com/o/r" },
    ]);
    await flush();
    expect(mockExecFile.mock.calls.length).toBe(callsAfterFirst);
  });

  it("unauthenticated stderr → reason unauthenticated", async () => {
    setGh({ pr: { __error: { code: 1, stderr: "gh auth login required" } } });
    githubActivityCache.enqueue([
      { slug: "x", path: "C:\\dev\\x", remoteUrl: "https://github.com/o/r" },
    ]);
    await flush();
    expect(githubActivityCache.get("x")?.reason).toBe("unauthenticated");
  });

  it("non-GitHub remote → not-a-github-repo and execFile is never called (P5)", async () => {
    setGh({ pr: [], run: [], repo: {} });
    githubActivityCache.enqueue([
      { slug: "gl", path: "C:\\dev\\gl", remoteUrl: "git@gitlab.com:o/r.git" },
    ]);
    await flush();

    const a = githubActivityCache.get("gl");
    expect(a?.available).toBe(false);
    expect(a?.reason).toBe("not-a-github-repo");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("no remote (no remoteUrl + git returns empty) → no-remote, no gh", async () => {
    setGh({ pr: [], run: [], repo: {} });
    mockRunGit.mockResolvedValue("");
    githubActivityCache.enqueue([{ slug: "bare", path: "C:\\dev\\bare" }]);
    await flush();

    const a = githubActivityCache.get("bare");
    expect(a?.reason).toBe("no-remote");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("falls back to git remote when no remoteUrl supplied", async () => {
    setGh({ pr: [], run: [], repo: { pushedAt: "2026-02-02T00:00:00Z" } });
    mockRunGit.mockResolvedValue("https://github.com/o/r.git");
    githubActivityCache.enqueue([{ slug: "g", path: "C:\\dev\\g" }]);
    await flush();

    const a = githubActivityCache.get("g");
    expect(a?.available).toBe(true);
    expect(a?.repo).toBe("o/r");
    expect(mockRunGit).toHaveBeenCalledWith(["remote", "get-url", "origin"], "C:\\dev\\g");
  });

  it("never throws on non-JSON stdout → reason error", async () => {
    mockExecFile.mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      cb: Cb
    ) => {
      cb(null, "this is not json", "");
    }) as unknown as typeof execFile);

    githubActivityCache.enqueue([
      { slug: "x", path: "C:\\dev\\x", remoteUrl: "https://github.com/o/r" },
    ]);
    await flush();

    const a = githubActivityCache.get("x");
    expect(a?.available).toBe(false);
    expect(a?.reason).toBe("error");
  });
});

describe("githubActivityCache.pending counts in-flight batches", () => {
  it("stays > 0 while a batch is in flight and drops to 0 only after results land", async () => {
    // Defer at the runGit step so the batch stays in-flight under our control.
    const deferred: Array<(v: string) => void> = [];
    mockRunGit.mockImplementation(
      () => new Promise<string>((resolve) => deferred.push(resolve))
    );

    githubActivityCache.enqueue([{ slug: "a", path: "C:\\dev\\a" }]);
    await flush();

    // The item has been spliced out of `queue` but its gh/git work hasn't
    // settled — pending must still report it (regression: previously read 0).
    expect(deferred.length).toBe(1);
    expect(githubActivityCache.pending).toBeGreaterThan(0);

    // Resolve (empty ⇒ no-remote) and let the result land.
    deferred[0]("");
    await flush();

    expect(githubActivityCache.pending).toBe(0);
  });

  it("dispose() while a batch is in flight leaves pending at 0 (no negative drift)", async () => {
    const deferred: Array<(v: string) => void> = [];
    mockRunGit.mockImplementation(
      () => new Promise<string>((resolve) => deferred.push(resolve))
    );

    githubActivityCache.enqueue([
      { slug: "a", path: "C:\\dev\\a" },
      { slug: "b", path: "C:\\dev\\b" },
    ]);
    await flush();
    expect(githubActivityCache.pending).toBeGreaterThan(0);

    githubActivityCache.dispose();
    expect(githubActivityCache.pending).toBe(0);

    // The in-flight finally runs after dispose; it must not drive inFlight < 0.
    deferred[0]("");
    deferred[1]("");
    await flush();
    expect(githubActivityCache.pending).toBe(0);
  });
});

describe("githubActivityCache.dispose() race protection", () => {
  it("drops in-flight batch results that land after dispose()", async () => {
    // Defer at the runGit step so the batch stays in-flight while we dispose().
    const deferred: Array<(v: string) => void> = [];
    mockRunGit.mockImplementation(
      () => new Promise<string>((resolve) => deferred.push(resolve))
    );

    githubActivityCache.enqueue([
      { slug: "a", path: "C:\\dev\\a" },
      { slug: "b", path: "C:\\dev\\b" },
    ]);
    await flush();

    expect(deferred.length).toBe(2);
    expect(githubActivityCache.total).toBe(0);

    // dispose() lands while the runGit subprocesses are still pending.
    githubActivityCache.dispose();

    // They now resolve (empty ⇒ no-remote). Without the generation guard these
    // would repopulate the cache we just cleared.
    deferred[0]("");
    deferred[1]("");
    await flush();

    expect(githubActivityCache.total).toBe(0);
    expect(githubActivityCache.get("a")).toBeNull();
    expect(githubActivityCache.get("b")).toBeNull();
  });
});
