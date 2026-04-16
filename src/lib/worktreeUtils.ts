/** Pure, browser-safe worktree utilities (no Node.js imports). */

/** Generates a collision-free process-manager slug for a worktree. */
export function worktreeSlug(parentSlug: string, branch: string): string {
  return `${parentSlug}:wt:${encodeURIComponent(branch)}`;
}
