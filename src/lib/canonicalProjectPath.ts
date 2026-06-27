import path from "path";
import { WORKTREE_SEP } from "./scanner/worktreeCheck";
import { isInside } from "./template/pathSafety";
import { getDevRoots, readConfig } from "./config";

export interface CanonicalResolution {
  /** Canonical main-tree project directory. */
  canonicalPath: string;
  /**
   * Reserved for Phase 2 (MCP write-bridge provenance) — no consumer yet.
   * True if the input was a worktree checkout that was redirected to its parent.
   */
  wasWorktree: boolean;
  /** Reserved for Phase 2 provenance — branch hint from the worktree dir name. */
  branchHint?: string;
}

/**
 * Resolve any project-ish path to its canonical main-tree project directory.
 *
 * Claude Code worktree dirs are named `{parent}--claude-worktrees-{branchHint}`
 * and live as siblings of the parent inside a dev root. Planning files
 * (TODO/MANUAL_STEPS/INSIGHTS/BOARD) are project-scoped, so every writer must
 * target the parent, never the worktree checkout — otherwise planning fragments
 * into N divergent copies that are invisible until merge.
 *
 * `devRoots` is a safety boundary, not the resolution mechanism: the parent is
 * always the worktree's sibling, but we only redirect a write if that sibling
 * sits inside a known dev root. If it doesn't (misconfiguration, or an input we
 * don't own), we refuse to redirect and treat the input as already canonical —
 * the safe choice, since redirecting to an unverified path could write planning
 * into the wrong place.
 */
export function resolveCanonicalProjectPath(
  cwd: string,
  devRoots: string[],
): CanonicalResolution {
  const dirName = path.basename(cwd);

  // WORKTREE_SEP is lowercase; match case-insensitively (Windows dir casing).
  const sepIndex = dirName.toLowerCase().indexOf(WORKTREE_SEP);
  if (sepIndex === -1) {
    // Not a worktree — return the input verbatim so non-worktree callers see
    // byte-identical behaviour (no surprise absolute-ization of relative paths).
    return { canonicalPath: cwd, wasWorktree: false };
  }

  const parentName = dirName.slice(0, sepIndex);
  const branchHint = dirName.slice(sepIndex + WORKTREE_SEP.length) || undefined;

  // Worktree and its parent project are siblings.
  const sibling = path.join(path.dirname(cwd), parentName);
  const resolvedSibling = path.resolve(sibling);

  const contained = devRoots.some((root) => isInside(resolvedSibling, path.resolve(root)));
  if (!contained) {
    // Refuse to redirect outside a known dev root — treat as canonical.
    return { canonicalPath: cwd, wasWorktree: false };
  }

  return { canonicalPath: sibling, wasWorktree: true, branchHint };
}

/**
 * Resolve a project-ish cwd to its canonical main-tree project *directory*,
 * reading dev roots from config. Thin impure wrapper over the pure
 * `resolveCanonicalProjectPath` so planning writers have a single choke point
 * instead of repeating the config-read + resolve at every call-site. (The pure
 * function stays config-free for testability.)
 */
export async function canonicalProjectDir(cwd: string): Promise<string> {
  const devRoots = getDevRoots(await readConfig());
  return resolveCanonicalProjectPath(cwd, devRoots).canonicalPath;
}
