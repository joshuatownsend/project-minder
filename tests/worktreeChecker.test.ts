import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("@/lib/processManager", () => ({ processManager: { get: vi.fn().mockReturnValue(undefined) } }));

import { execFile } from "child_process";
import { checkWorktreeStatus } from "@/lib/worktreeChecker";
import { worktreeSlug } from "@/lib/worktreeUtils";

const execFileMock = vi.mocked(execFile);

/** Stub sequential execFile calls. Call order in checkWorktreeStatus:
 *  0: git symbolic-ref refs/remotes/origin/HEAD  → default branch ref
 *  1: git branch --merged <defaultBranch>         → merged branches
 *  2: git ls-remote --heads origin <branch>       → remote ref (empty = deleted)
 *  3: git status --porcelain                      → dirty files
 *  4: git log -1 --format=%aI                     → last commit date
 */
function stubOutputs(outputs: string[]) {
  let call = 0;
  execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
    const cb = callback as (err: null, stdout: string, stderr: string) => void;
    cb(null, (outputs[call++] ?? "") + "\n", "");
    return {} as ReturnType<typeof execFile>;
  });
}

describe("worktreeSlug", () => {
  it("URL-encodes slashes in branch name (collision-safe)", () => {
    expect(worktreeSlug("my-app", "feature/foo-bar")).toBe("my-app:wt:feature%2Ffoo-bar");
  });

  it("handles branch with no slashes", () => {
    expect(worktreeSlug("my-app", "main")).toBe("my-app:wt:main");
  });

  it("distinguishes branches that differ only by slash position", () => {
    const a = worktreeSlug("app", "feature/foo-bar");
    const b = worktreeSlug("app", "feature-foo/bar");
    expect(a).not.toBe(b);
  });
});

describe("checkWorktreeStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks stale when merged locally and remote deleted", async () => {
    stubOutputs(["refs/remotes/origin/main", "  main\n  feature/foo", "", "", "2026-04-01T10:00:00Z"]);
    const s = await checkWorktreeStatus("C:/dev/p", "C:/dev/p--wt", "feature/foo");
    expect(s.isMergedLocally).toBe(true);
    expect(s.isRemoteBranchDeleted).toBe(true);
    expect(s.isStale).toBe(true);
    expect(s.isDirty).toBe(false);
  });

  it("strips worktree '+' prefix from git branch --merged output", async () => {
    // git branch --merged prefixes linked worktrees with "+ " not "* "
    stubOutputs(["refs/remotes/origin/main", "  main\n+ feature/wt-branch", "", "", ""]);
    const s = await checkWorktreeStatus("C:/dev/p", "C:/dev/p--wt", "feature/wt-branch");
    expect(s.isMergedLocally).toBe(true);
  });

  it("not stale when remote branch still exists", async () => {
    stubOutputs(["refs/remotes/origin/main", "  main", "abc123\trefs/heads/feature/foo", "", ""]);
    const s = await checkWorktreeStatus("C:/dev/p", "C:/dev/p--wt", "feature/foo");
    expect(s.isStale).toBe(false);
  });

  it("reports dirty worktree", async () => {
    stubOutputs(["refs/remotes/origin/main", "  main", "", " M src/foo.ts\nA  src/bar.ts", ""]);
    const s = await checkWorktreeStatus("C:/dev/p", "C:/dev/p--wt", "feature/foo");
    expect(s.isDirty).toBe(true);
    expect(s.uncommittedCount).toBe(2);
  });

  it("returns isStale false when git fails (offline safety)", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: Error) => void)(new Error("network unreachable"));
      return {} as ReturnType<typeof execFile>;
    });
    const s = await checkWorktreeStatus("C:/dev/p", "C:/dev/p--wt", "feature/foo");
    expect(s.isStale).toBe(false);
  });

  it("falls back to 'main' when symbolic-ref unavailable", async () => {
    // First call (symbolic-ref) returns empty → falls back to "main"
    stubOutputs(["", "  main\n  feature/foo", "", "", ""]);
    const s = await checkWorktreeStatus("C:/dev/p", "C:/dev/p--wt", "feature/foo");
    expect(s.isMergedLocally).toBe(true);
  });
});

describe("safe.directory waiver", () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * Same silent-no-op hazard pinned in tests/git.scanner.test.ts, and the
   * reason this file's git calls needed the waiver at all: without it, every
   * worktree status check against a UNC/WSL repo fails with "detected dubious
   * ownership" and is swallowed into ""/null. (Requested by Copilot on #340.)
   */
  const PARENT = "\\\\wsl.localhost\\Ubuntu\\home\\josh\\repo";
  const WORKTREE = "\\\\wsl.localhost\\Ubuntu\\home\\josh\\repo--claude-worktrees-x";

  it("scopes safe.directory to each call's own cwd, before the subcommand", async () => {
    stubOutputs(["refs/remotes/origin/main", "", "", "", ""]);
    await checkWorktreeStatus(PARENT, WORKTREE, "feature/x");

    expect(execFileMock.mock.calls.length).toBeGreaterThan(0);
    for (const [bin, args, opts] of execFileMock.mock.calls) {
      expect(bin).toBe("git");
      // `-c` is a git-level option: after the subcommand it silently no-ops.
      expect((args as string[])[0]).toBe("-c");
      // The waiver must name the directory THIS call reads. checkWorktreeStatus
      // uses two different cwds — the parent repo for branch/remote queries and
      // the worktree for status/log — so a single hardcoded value would trust
      // the wrong tree for half the calls. Backslashes must also be normalized,
      // or the value never matches the path git reports and the waiver silently
      // stops applying on UNC.
      const cwd = (opts as { cwd: string }).cwd;
      expect((args as string[])[1]).toBe(
        `safe.directory=${cwd.replace(/\\/g, "/")}`
      );
    }

    // Both cwds were actually exercised — otherwise the assertion above could
    // pass while only ever seeing one of them.
    const cwds = new Set(
      execFileMock.mock.calls.map((c) => (c[2] as { cwd: string }).cwd)
    );
    expect(cwds).toEqual(new Set([PARENT, WORKTREE]));
  });

  it("never uses the * wildcard, which would trust nested foreign repos", async () => {
    stubOutputs(["refs/remotes/origin/main", "", "", "", ""]);
    await checkWorktreeStatus("C:\\dev\\repo", "C:\\dev\\repo-wt", "feature/x");

    for (const [, args] of execFileMock.mock.calls) {
      expect(args as string[]).not.toContain("safe.directory=*");
    }
  });
});
