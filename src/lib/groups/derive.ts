import type { ProjectData } from "@/lib/types/project";
import { normalizeRemote } from "./identity";
import type { ProjectGroup, ProjectGroupMember } from "./types";

/**
 * The read-set, documented as a type — same pattern as `deriveOpsSummary`
 * (`src/lib/ops/summary.ts`). Callers and tests build this, not a whole
 * `ProjectData`.
 */
export type GroupableProject = Pick<
  ProjectData,
  "slug" | "path" | "git" | "usageHomeKey"
>;

export interface DeriveGroupsOptions {
  /**
   * Checkout paths the user has opted out of grouping.
   *
   * Keyed on PATH, not slug, and that is load-bearing: `resolveProjectSlug`
   * hands the undecorated slug to whichever root sorts first, so slugs move
   * between rescans when `devRoots` is reordered (documented at
   * `src/lib/scanner/index.ts:125-129`). A slug-keyed opt-out would silently
   * stop matching after a reorder — failing in the direction of re-merging
   * checkouts the user explicitly asked to keep apart.
   */
  ungroupedPaths?: readonly string[];
}

/**
 * Group scanned projects by normalized git remote.
 *
 * Pure and synchronous: no fs, no async, no scanning. Reshapes what the
 * scanner already found, so it is unit-testable like a parser and safe to run
 * client-side.
 *
 * Worktrees need no exclusion here. A worktree's `.git` is a file, not a
 * directory, so `isGitRepo` (`scanner/index.ts:151`) rejects it before slug
 * assignment — worktree dirs never become `ProjectData` and are attached
 * separately as `WorktreeOverlay`. See `tests/projectGroups.test.ts` for the
 * regression test that pins this.
 */
export function deriveProjectGroups(
  projects: readonly GroupableProject[],
  options: DeriveGroupsOptions = {}
): ProjectGroup[] {
  const ungrouped = new Set(
    (options.ungroupedPaths ?? []).map(normalizePathKey)
  );

  const byKey = new Map<string, ProjectGroupMember[]>();
  for (const p of projects) {
    if (ungrouped.has(normalizePathKey(p.path))) continue;
    const key = normalizeRemote(p.git?.remoteUrl);
    // No remote (or an unparseable one) means the project groups alone —
    // which is to say it is not a group at all.
    if (!key) continue;
    const members = byKey.get(key);
    const member: ProjectGroupMember = { slug: p.slug, path: p.path };
    if (p.usageHomeKey) member.usageHomeKey = p.usageHomeKey;
    if (members) members.push(member);
    else byKey.set(key, [member]);
  }

  const groups: ProjectGroup[] = [];
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    members.sort((a, b) => compare(a.path, b.path));
    groups.push({ key, slug: "", name: repoFromKey(key), members });
  }

  groups.sort((a, b) => compare(a.key, b.key));
  assignGroupSlugs(groups);
  return groups;
}

/**
 * Canonicalize a checkout path for comparison against `ungroupedPaths`.
 *
 * `ungroupedPaths` is hand-edited in `.minder.json`, where a Windows path needs
 * doubled backslashes (`"C:\\dev\\foo"`). Writing `"C:/dev/foo"` instead is both
 * natural and valid, so separators are folded — otherwise the opt-out silently
 * matches nothing while looking correctly configured, which is worse than
 * rejecting it outright. Case is folded because Windows paths are
 * case-insensitive, and a trailing separator is trimmed for the same reason.
 */
function normalizePathKey(value: string): string {
  return value.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Codepoint compare — deliberately not `localeCompare`, matching the scanner's slug ordering. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function repoFromKey(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

function ownerFromKey(key: string): string {
  const parts = key.split("/");
  return parts.length >= 3 ? parts[parts.length - 2] : "";
}

/**
 * Mirrors `toSlug` in `scanner/index.ts`. Duplicated rather than imported
 * because that module pulls in `fs` at module scope, and this one must stay
 * client-safe.
 */
function toGroupSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/**
 * Assign each group a slug unique within the `/group/` namespace.
 *
 * Group-vs-project collisions are fine by design — the chosen URL space keeps
 * `/project/<slug>` meaning exactly what it means today, so `/group/bamcli`
 * and `/project/bamcli` coexist. Only group-vs-group collisions need
 * resolving, which happens when two owners publish the same repo name; those
 * disambiguate by owner, then by a counter.
 */
function assignGroupSlugs(groups: ProjectGroup[]): void {
  const taken = new Set<string>();
  for (const g of groups) {
    const base = toGroupSlug(repoFromKey(g.key));
    const owner = toGroupSlug(ownerFromKey(g.key));
    let slug = "";
    for (const candidate of [base, owner ? `${base}-${owner}` : ""]) {
      if (candidate && !taken.has(candidate)) {
        slug = candidate;
        break;
      }
    }
    for (let n = 2; !slug; n++) {
      if (!taken.has(`${base}-${n}`)) slug = `${base}-${n}`;
    }
    taken.add(slug);
    g.slug = slug;
  }
}
