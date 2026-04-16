import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("@/lib/processManager", () => ({ processManager: { get: vi.fn().mockReturnValue(undefined) } }));

import { execFile } from "child_process";
import { checkWorktreeStatus } from "@/lib/worktreeChecker";

const execFileMock = vi.mocked(execFile);

function stubOutputs(outputs: string[]) {
  let call = 0;
  execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
    const cb = callback as (err: null, stdout: string, stderr: string) => void;
    cb(null, (outputs[call++] ?? "") + "\n", "");
    return {} as ReturnType<typeof execFile>;
  });
}

describe("checkWorktreeStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks stale when merged locally and remote deleted", async () => {
    stubOutputs(["  main\n  feature/foo", "", "", "2026-04-01T10:00:00Z"]);
    const s = await checkWorktreeStatus("C:/dev/p", "C:/dev/p--wt", "feature/foo", "p:wt:feature-foo");
    expect(s.isMergedLocally).toBe(true);
    expect(s.isRemoteBranchDeleted).toBe(true);
    expect(s.isStale).toBe(true);
    expect(s.isDirty).toBe(false);
  });

  it("not stale when remote branch still exists", async () => {
    stubOutputs(["  main", "abc123\trefs/heads/feature/foo", "", ""]);
    const s = await checkWorktreeStatus("C:/dev/p", "C:/dev/p--wt", "feature/foo", "p:wt:feature-foo");
    expect(s.isStale).toBe(false);
  });

  it("reports dirty worktree", async () => {
    stubOutputs(["  main", "", " M src/foo.ts\nA  src/bar.ts", ""]);
    const s = await checkWorktreeStatus("C:/dev/p", "C:/dev/p--wt", "feature/foo", "p:wt:feature-foo");
    expect(s.isDirty).toBe(true);
    expect(s.uncommittedCount).toBe(2);
  });

  it("returns isStale false when git fails (offline safety)", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: Error) => void)(new Error("network unreachable"));
      return {} as ReturnType<typeof execFile>;
    });
    const s = await checkWorktreeStatus("C:/dev/p", "C:/dev/p--wt", "feature/foo", "p:wt:feature-foo");
    expect(s.isStale).toBe(false);
  });
});
