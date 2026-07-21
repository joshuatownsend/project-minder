/**
 * Types for project groups — one logical project checked out in several
 * locations (e.g. a Windows checkout and a WSL checkout of the same repo).
 *
 * Deliberately standalone: this module imports nothing, so
 * `src/lib/types/project.ts` can reference `ProjectGroup` on `ScanResult`
 * without a circular import back through the derive layer.
 */

/** One checkout belonging to a group. */
export interface ProjectGroupMember {
  /**
   * The member's own scan slug. Still the route identity for
   * `/project/<slug>` — grouping adds a namespace, it does not move members.
   */
  slug: string;
  /**
   * Full path to this checkout. The durable member identity: unlike a slug,
   * a path does not move when scan roots are reordered.
   */
  path: string;
  /**
   * Which Claude home owns this location, when it resolves. Set only for
   * mapped (UNC-scanned WSL) projects — absent on the local side of a pair,
   * so it distinguishes members but cannot be relied on as a key.
   */
  usageHomeKey?: string;
}

/**
 * A repo with more than one checkout.
 *
 * Groups of one are never emitted. The plan requires that a single-location
 * project stay byte-for-byte what it is today; not emitting it makes that
 * structural rather than a rendering convention every consumer has to honour.
 */
export interface ProjectGroup {
  /**
   * Normalized remote (`host/owner/repo`). The durable group identity —
   * independent of scan-root order, unlike slugs.
   */
  key: string;
  /**
   * URL slug for `/group/<slug>`. Unique within the group namespace only:
   * `/group/bamcli` and `/project/bamcli` are different pages about related
   * things, and that collision is intended, not a defect.
   */
  slug: string;
  /** Display name — the repo name from the remote. */
  name: string;
  /** Members, ordered by path for stable output. Always length >= 2. */
  members: ProjectGroupMember[];
}
