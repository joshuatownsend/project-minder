/** Pure worktree-dir detection — no Node.js imports; safe for client components. */

export const WORKTREE_SEP = "--claude-worktrees-";

export function isWorktreeEncodedDir(encodedDirName: string): boolean {
  return encodedDirName.includes(WORKTREE_SEP);
}

/**
 * Returns true when `filePath` points at a JSONL inside a Claude Code
 * worktree directory. The DB loaders need this variant because
 * `project_dir_name` gets canonicalized at ingest (`canonicalizeDirName`
 * strips the `--claude-worktrees-*` suffix to group worktree sessions
 * under the parent project's slug), so they can't recover the worktree
 * fact from `project_dir_name` alone — only from the raw `file_path`
 * column which threads through unchanged from `walkProjects`.
 *
 * Substring match is safe: `WORKTREE_SEP` is Claude Code's own naming
 * convention and is distinctive enough that an accidental hit elsewhere
 * in a filesystem path doesn't happen in practice.
 */
export function isWorktreeFilePath(filePath: string): boolean {
  return filePath.includes(WORKTREE_SEP);
}
