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

/** Resolves the repo's default branch via origin/HEAD; falls back to "main". */
async function getDefaultBranch(cwd: string): Promise<string> {
  const ref = await runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
  return match ? match[1] : "main";
}

function parseMergedBranches(mergedOutput: string): string[] {
  return mergedOutput
    .split("\n")
    // Strip both "* " (current branch) and "+ " (checked-out-in-worktree) markers
    .map((l) => l.trim().replace(/^[*+]\s*/, ""))
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
  const defaultBranch = await getDefaultBranch(parentPath);
  const [mergedOutput, remoteOutput, porcelain, lastCommit] = await Promise.all([
    runGit(["branch", "--merged", defaultBranch], parentPath),
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

/** Efficient multi-worktree variant: resolves default branch and runs git branch --merged once for all worktrees. */
export async function checkAllWorktreeStatuses(
  parentPath: string,
  worktrees: Array<{ worktreePath: string; branch: string }>
): Promise<WorktreeStatus[]> {
  const defaultBranch = await getDefaultBranch(parentPath);
  const mergedOutput = await runGit(["branch", "--merged", defaultBranch], parentPath);
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
