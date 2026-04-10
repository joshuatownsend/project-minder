import { promises as fs } from "fs";
import path from "path";
import { ProjectData, WorktreeOverlay } from "../types";
import { scanTodoMd } from "./todoMd";
import { scanManualStepsMd } from "./manualStepsMd";
import { scanInsightsMd } from "./insightsMd";

const WORKTREE_SEP = "--claude-worktrees-";

/**
 * Parse the branch name from a worktree's `.git` file.
 *
 * Worktree `.git` files contain a single line like:
 *   gitdir: C:/dev/project-minder/.git/worktrees/feature-gitwc
 *
 * From that gitdir path, we read the `HEAD` file to get the actual branch ref.
 * Falls back to deriving a branch hint from the directory name.
 */
async function readWorktreeBranch(
  worktreePath: string,
  branchHint: string
): Promise<string> {
  try {
    const gitFileContent = await fs.readFile(
      path.join(worktreePath, ".git"),
      "utf-8"
    );
    const gitdirMatch = gitFileContent.trim().match(/^gitdir:\s*(.+)$/m);
    if (!gitdirMatch) return fallbackBranch(branchHint);

    const gitdir = gitdirMatch[1].trim();
    const headContent = await fs.readFile(
      path.join(gitdir, "HEAD"),
      "utf-8"
    );
    const refMatch = headContent.trim().match(/^ref:\s*refs\/heads\/(.+)$/);
    if (refMatch) return refMatch[1];

    // Detached HEAD — use hint
    return fallbackBranch(branchHint);
  } catch {
    return fallbackBranch(branchHint);
  }
}

/**
 * Convert a directory-name branch hint to a plausible branch name.
 * Claude Code encodes `/` as `-` in directory names, but branch names
 * commonly use a single namespace prefix (feature/, fix/, etc.).
 * Replace only the first `-` with `/` if the hint contains one.
 */
function fallbackBranch(hint: string): string {
  return hint.replace("-", "/");
}

/**
 * Discover worktree directories in devRoot and attach their markdown
 * file data to the corresponding parent projects.
 *
 * Mutates the `projects` array in-place, adding `worktrees` arrays.
 */
export async function attachWorktreeOverlays(
  projects: ProjectData[],
  allDirNames: string[],
  devRoot: string
): Promise<void> {
  // Build a lookup: lowercase dir name → project
  const dirNameToProject = new Map<string, ProjectData>();
  for (const p of projects) {
    const dirName = path.basename(p.path);
    dirNameToProject.set(dirName.toLowerCase(), p);
  }

  // Find worktree directories
  const worktreeDirs = allDirNames.filter((d) =>
    d.toLowerCase().includes(WORKTREE_SEP.toLowerCase())
  );

  if (worktreeDirs.length === 0) return;

  // Process worktree directories in parallel
  const tasks = worktreeDirs.map(async (dirName) => {
    const sepIndex = dirName.toLowerCase().indexOf(WORKTREE_SEP.toLowerCase());
    const prefix = dirName.slice(0, sepIndex);
    const branchHint = dirName.slice(sepIndex + WORKTREE_SEP.length);

    // Find parent project
    const parent = dirNameToProject.get(prefix.toLowerCase());
    if (!parent) return;

    const worktreePath = path.join(devRoot, dirName);

    // Read actual branch name and markdown files in parallel
    const [branch, todos, manualSteps, insights] = await Promise.all([
      readWorktreeBranch(worktreePath, branchHint),
      scanTodoMd(worktreePath),
      scanManualStepsMd(worktreePath),
      scanInsightsMd(worktreePath),
    ]);

    // Only attach if at least one file has data
    if (!todos && !manualSteps && !insights) return;

    const overlay: WorktreeOverlay = {
      branch,
      worktreePath,
      todos,
      manualSteps,
      insights,
    };

    if (!parent.worktrees) parent.worktrees = [];
    parent.worktrees.push(overlay);
  });

  await Promise.all(tasks);
}
