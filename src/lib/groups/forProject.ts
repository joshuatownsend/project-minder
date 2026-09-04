import { deriveProjectGroups, type DeriveGroupsOptions, type GroupableProject } from "./derive";
import type { ProjectGroupRef } from "./types";

/**
 * The group one project belongs to, as a reference the member page can link
 * from — or `undefined` when the project groups alone.
 *
 * Runs the same derivation `withGroups` runs for the dashboard, over the same
 * scan and the same opt-out list, so the member page and the dashboard chip
 * can never disagree about whether a project is grouped. A group of one is
 * never emitted by `deriveProjectGroups`, so a lone checkout resolves to
 * `undefined` here rather than to a group with one member.
 */
export function groupForProject(
  projects: readonly GroupableProject[],
  slug: string,
  options: DeriveGroupsOptions = {}
): ProjectGroupRef | undefined {
  const group = deriveProjectGroups(projects, options).find((g) =>
    g.members.some((m) => m.slug === slug)
  );
  if (!group) return undefined;
  return { slug: group.slug, name: group.name, memberCount: group.members.length };
}
