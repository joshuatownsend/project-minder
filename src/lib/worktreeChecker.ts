import { execFile } from "child_process";
import { WorktreeStatus } from "./types";

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

export async function checkWorktreeStatus(
  parentPath: string,
  worktreePath: string,
  branch: string,
  _worktreeSlug: string
): Promise<WorktreeStatus> {
  const [mergedOutput, remoteOutput, porcelain, lastCommit] = await Promise.all([
    runGit(["branch", "--merged", "main"], parentPath),
    runGitNullable(["ls-remote", "--heads", "origin", branch], parentPath),
    runGit(["status", "--porcelain"], worktreePath),
    runGit(["log", "-1", "--format=%aI"], worktreePath),
  ]);

  const mergedBranches = mergedOutput
    .split("\n")
    .map((l) => l.trim().replace(/^\*\s*/, ""))
    .filter(Boolean);
  const isMergedLocally = mergedBranches.includes(branch);
  // null = network/remote error (unknown), treat as NOT deleted to avoid false staleness
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
