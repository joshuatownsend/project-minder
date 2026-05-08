export interface BranchStat {
  branch: string;
  sessionCount: number;
  lastActivity: string;
}

export interface GitActivitySummary {
  commits: number;
  pushes: number;
  branches: BranchStat[];
}

// Matches `git commit` but not `git commit-tree` etc. (--amend commits are intentionally counted)
const COMMIT_RE = /^\s*git\s+commit(\s|$)/m;
// Matches `git push` but not `git push-pack` etc.
const PUSH_RE = /^\s*git\s+push(\s|$)/m;

export function aggregateGitActivity(
  toolCommands: Array<{ command: string }>,
  sessionBranches: Array<{ branch: string | null; lastActivity: string }>
): GitActivitySummary {
  let commits = 0;
  let pushes = 0;

  for (const { command } of toolCommands) {
    if (COMMIT_RE.test(command)) commits++;
    if (PUSH_RE.test(command)) pushes++;
  }

  const branchMap = new Map<string, { count: number; lastActivity: string }>();
  for (const { branch, lastActivity } of sessionBranches) {
    if (!branch) continue;
    const existing = branchMap.get(branch);
    if (!existing || lastActivity > existing.lastActivity) {
      branchMap.set(branch, {
        count: (existing?.count ?? 0) + 1,
        lastActivity,
      });
    } else {
      existing.count++;
    }
  }

  const branches: BranchStat[] = Array.from(branchMap.entries())
    .map(([branch, { count, lastActivity }]) => ({
      branch,
      sessionCount: count,
      lastActivity,
    }))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    .slice(0, 15);

  return { commits, pushes, branches };
}
