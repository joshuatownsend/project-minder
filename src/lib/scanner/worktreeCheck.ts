/** Pure worktree-dir detection — no Node.js imports; safe for client components. */

export const WORKTREE_SEP = "--claude-worktrees-";

export function isWorktreeEncodedDir(encodedDirName: string): boolean {
  return encodedDirName.includes(WORKTREE_SEP);
}
