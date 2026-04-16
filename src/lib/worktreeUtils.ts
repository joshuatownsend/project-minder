/** Pure, browser-safe worktree utilities (no Node.js imports). */

export function worktreeSlug(parentSlug: string, branch: string): string {
  return `${parentSlug}:wt:${branch.replace(/\//g, "-")}`;
}
