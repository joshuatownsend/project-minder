/**
 * How a session's encoded project directory name becomes a project identity.
 *
 * Both functions here are pure, dependency-free string rules, and they used to
 * live in two of the heaviest modules in the tree — `toSlug` in
 * `scanner/claudeConversations.ts`, `canonicalizeDirName` in
 * `usage/parser.ts`. That placement had two costs:
 *
 *  - **A cycle.** `usage/parser` imported `toSlug` from `claudeConversations`
 *    while `claudeConversations` imported `canonicalizeDirName` back. It worked,
 *    because neither is called at module-evaluation time, but it meant nothing
 *    leaf-ward of both could use either.
 *  - **A hand-copy.** `data/sessionsListFromDb.ts` carried its own three-line
 *    `slugifyDirName` mirror of `toSlug`, with a comment saying the two "must
 *    move together" — precisely the arrangement #483 was, where five copied
 *    predicates agreed perfectly and were wrong together. It is deleted now
 *    that there is somewhere light enough for the read path to import from.
 *
 * This module may import nothing from `src/lib` at all. That is the property
 * that makes it usable from the scanner, the indexer, the SQL read path, and
 * the adapters alike, and it is worth protecting.
 */

/**
 * Slugify an encoded project directory name (`C--dev-my-app` → `dev-my-app`).
 *
 * The leading drive-letter segment is dropped by skipping to the first part
 * longer than one character.
 */
export function toSlug(dirName: string): string {
  // Extract last segment as project name, slugify
  const parts = dirName.split("-");
  // Skip drive letter prefix like "C-"
  const meaningful = parts.slice(parts.findIndex((p) => p.length > 1));
  return meaningful.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

// In the encoded dir name, ':', '\', and '.' all become '-'.
// Windows paths start with '{Drive}--' (drive colon + first backslash).
// Any '--' after that initial prefix represents '\.' — a dot-prefixed component.
// Worktree dirs are always dot-prefixed (.worktrees, .claude-worktrees, etc.),
// so strip the worktree suffix to group their sessions with the parent project.
// We scan '--' occurrences left-to-right and stop at the FIRST worktree marker.
// Earlier dot-prefixed dirs (e.g. '--cache') don't match the pattern, so the
// loop naturally skips them. Stopping at the first match also ensures a branch
// name that happens to contain '--worktrees-' is never treated as a second marker.
export function canonicalizeDirName(dirName: string): string {
  const searchFrom = /^[A-Za-z]--/.test(dirName) ? 2 : 0;
  let pos = searchFrom;
  while (pos < dirName.length) {
    const idx = dirName.indexOf("--", pos);
    if (idx === -1) break;
    if (/^(?:[a-z]+-)?worktrees-/.test(dirName.slice(idx + 2))) {
      return dirName.slice(0, idx);
    }
    pos = idx + 2;
  }
  return dirName;
}

/**
 * The project slug a session groups under: canonicalize, then slugify.
 *
 * **Every producer of a session's project slug from an ENCODED DIR NAME calls
 * this** — both adapters, ingest, both file-parse sweeps, and the shared
 * summary projection. That is the property worth protecting: a worktree
 * session from any harness groups with its parent project because there is one
 * composition, not eight agreeing ones (#497, #496).
 *
 * Note the qualifier. `scanner/index.ts` exports a DIFFERENT `toSlug` that
 * slugifies a filesystem directory basename into a dashboard route slug, and
 * several callers slugify a plain basename for their own keys. Those are not
 * this, and folding them in would be wrong rather than tidy.
 *
 * Skipping `canonicalizeDirName` is the mistake this exists to prevent — it is
 * what #497 was, in two adapters at once. The reverse order happens to give the
 * same answer for every dir-name shape in play, so order is not the hazard.
 */
export function projectSlugFromDirName(dirName: string): string {
  return toSlug(canonicalizeDirName(dirName));
}
