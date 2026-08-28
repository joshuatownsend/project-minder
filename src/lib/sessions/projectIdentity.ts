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
 * The leading path prefix is dropped explicitly rather than by a heuristic.
 * A Windows encoding starts with `{Drive}--` — the drive letter plus the empty
 * segment the doubled dash produces — so `C:\dev\my-app` splits to
 * `["C", "", "dev", "my", "app"]` and the first two go. A POSIX or UNC
 * encoding starts with one or more empty segments from its leading slashes,
 * so those go instead.
 *
 * This is the same prefix rule `canonicalizeDirName` below already applies
 * (`/^[A-Za-z]--/` → start at 2), which is why they now agree on where a path
 * actually begins.
 *
 * It used to scan for the first segment longer than one character, which is
 * only *incidentally* the same rule: it also dropped short leading segments
 * that were real path components, and when EVERY segment was one character
 * `findIndex` returned -1 and `slice(-1)` kept only the last — `C--a-b` slugged
 * to `"b"` rather than `"a-b"`. See #502; measured, not theorised.
 */
export function toSlug(dirName: string): string {
  const parts = dirName.split("-");
  let start = /^[A-Za-z]--/.test(dirName) ? 2 : 0;
  while (parts[start] === "") start++;
  return parts
    .slice(start)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
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
