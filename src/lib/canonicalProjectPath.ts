import path from "path";
import { WORKTREE_SEP } from "./scanner/worktreeCheck";

export interface CanonicalResolution {
  /** Canonical main-tree project directory (absolute). */
  canonicalPath: string;
  /** True if the input was a worktree checkout that was redirected to its parent. */
  wasWorktree: boolean;
  /** Branch hint extracted from the worktree dir name, if any. */
  branchHint?: string;
}

/** True when `child` is `parent` or sits inside it. Case-insensitive on win32. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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

  const contained = devRoots.some((root) =>
    isInside(path.resolve(root), path.resolve(sibling)),
  );
  if (!contained) {
    // Refuse to redirect outside a known dev root — treat as canonical.
    return { canonicalPath: cwd, wasWorktree: false };
  }

  return { canonicalPath: sibling, wasWorktree: true, branchHint };
}
