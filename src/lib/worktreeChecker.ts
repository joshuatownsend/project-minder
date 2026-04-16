import { execFile } from "child_process";
import { WorktreeStatus } from "./types";

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000 }, (err, stdout) => {
      resolve(err ? "" : stdout.trim());
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
    runGit(["ls-remote", "--heads", "origin", branch], parentPath),
    runGit(["status", "--porcelain"], worktreePath),
    runGit(["log", "-1", "--format=%aI"], worktreePath),
  ]);

  const mergedBranches = mergedOutput
    .split("\n")
    .map((l) => l.trim().replace(/^\*\s*/, ""))
    .filter(Boolean);
  const isMergedLocally = mergedBranches.includes(branch);
  const isRemoteBranchDeleted = remoteOutput.trim() === "";
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
