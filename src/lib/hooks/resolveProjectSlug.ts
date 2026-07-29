import path from "path";
import { getCachedScan } from "@/lib/cache";
import { toSlug } from "@/lib/scanner/index";

/** Returned when a cwd cannot be resolved to any known project. */
export const UNKNOWN_PROJECT_SLUG = "__unknown__";

/**
 * Resolve a hook payload's `cwd` to a Project Minder project slug.
 *
 * Shared by both hook receivers because the slug is not cosmetic: it is the
 * key every consumer joins on — the live-activity buffer, the event bus, and
 * the `/project/<slug>` deep link a notification opens. A hook that invented
 * its own slug (or passed a session id through) would produce notifications
 * pointing at a route that does not exist.
 *
 * Matching is longest-prefix-free on purpose: the first project whose path
 * contains `cwd` wins. Claude Code reports the *session* cwd, which is
 * frequently a subdirectory (or a worktree), so an exact-match-only lookup
 * would miss most real sessions.
 */
export function resolveProjectSlug(cwd: string): string {
  const resolved = path.resolve(cwd);
  const scan = getCachedScan();
  if (scan) {
    for (const p of scan.projects) {
      if (!p.path) continue;
      const projectResolved = path.resolve(p.path);
      // Exact match or cwd is a subdirectory of the project
      if (
        resolved === projectResolved ||
        (resolved.startsWith(projectResolved + path.sep) &&
          !path.relative(projectResolved, resolved).startsWith(".."))
      ) {
        return p.slug;
      }
    }
  }
  // Fallback: derive slug from the directory basename (may not match exactly)
  return toSlug(path.basename(resolved)) || UNKNOWN_PROJECT_SLUG;
}
