import { execFile } from "child_process";
import { WorktreeStatus } from "./types";
export { worktreeSlug } from "./worktreeUtils";

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000 }, (err, stdout) => {
      resolve(err ? "" : stdout.trim());
    });
  });
}

/** Returns null if the command failed (e.g., network error), empty string if command succeeded with no output. */
function runGitNullable(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

function parseMergedBranches(mergedOutput: string): string[] {
  return mergedOutput
    .split("\n")
    .map((l) => l.trim().replace(/^\*\s*/, ""))
    .filter(Boolean);
}

function parseStatus(
  mergedBranches: string[],
  remoteOutput: string | null,
  porcelain: string,
  lastCommit: string,
  worktreePath: string,
  branch: string
): WorktreeStatus {
  const isMergedLocally = mergedBranches.includes(branch);
  // null = network/remote error (unknown) — treat as NOT deleted to avoid false staleness
  const isRemoteBranchDeleted = remoteOutput !== null && remoteOutput.trim() === "";
  const porcelainLines = porcelain ? porcelain.split("\n").filter((l) => l.trim()) : [];
  return {
    worktreePath,
    branch,
    isDirty: porcelainLines.length > 0,
    uncommittedCount: porcelainLines.length,
    isMergedLocally,
    isRemoteBranchDeleted,
    isStale: isMergedLocally && isRemoteBranchDeleted,
    lastCommitDate: lastCommit || undefined,
  };
}

export async function checkWorktreeStatus(
  parentPath: string,
  worktreePath: string,
  branch: string
): Promise<WorktreeStatus> {
  const [mergedOutput, remoteOutput, porcelain, lastCommit] = await Promise.all([
    runGit(["branch", "--merged", "main"], parentPath),
    runGitNullable(["ls-remote", "--heads", "origin", branch], parentPath),
    runGit(["status", "--porcelain"], worktreePath),
    runGit(["log", "-1", "--format=%aI"], worktreePath),
  ]);
  return parseStatus(
    parseMergedBranches(mergedOutput),
    remoteOutput,
    porcelain,
    lastCommit,
    worktreePath,
    branch
  );
}

/** Efficient multi-worktree variant: runs `git branch --merged main` once for all worktrees. */
export async function checkAllWorktreeStatuses(
  parentPath: string,
  worktrees: Array<{ worktreePath: string; branch: string }>
): Promise<WorktreeStatus[]> {
  const mergedOutput = await runGit(["branch", "--merged", "main"], parentPath);
  const mergedBranches = parseMergedBranches(mergedOutput);

  return Promise.all(
    worktrees.map(async ({ worktreePath, branch }) => {
      const [remoteOutput, porcelain, lastCommit] = await Promise.all([
        runGitNullable(["ls-remote", "--heads", "origin", branch], parentPath),
        runGit(["status", "--porcelain"], worktreePath),
        runGit(["log", "-1", "--format=%aI"], worktreePath),
      ]);
      return parseStatus(mergedBranches, remoteOutput, porcelain, lastCommit, worktreePath, branch);
    })
  );
}
