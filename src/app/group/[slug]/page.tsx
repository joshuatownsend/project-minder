"use client";

import { use, useMemo } from "react";
import { useProjects } from "@/hooks/useProjects";
import { GroupDetail } from "@/components/groups/GroupDetail";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

/**
 * `/group/<slug>` — a separate namespace from `/project/<slug>` (decided in
 * P1): `/group/bamcli` and `/project/bamcli` are different pages about
 * related things, and the slug collision is intended.
 *
 * No group API: the page reads the same `ScanResult` the dashboard does and
 * resolves the group's members from it. `skippedRoots` rides along so a
 * member carried forward from a skipped root is flagged stale.
 */
export default function GroupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { data, loading } = useProjects();

  const group = data?.groups?.find((g) => g.slug === slug);
  const members = useMemo(() => {
    if (!group || !data) return [];
    const bySlug = new Map(data.projects.map((p) => [p.slug, p]));
    return group.members.map((m) => bySlug.get(m.slug)).filter((p): p is NonNullable<typeof p> => p !== undefined);
  }, [group, data]);
  const skippedRootPaths = useMemo(() => data?.skippedRoots?.map((r) => r.root) ?? [], [data]);

  useDocumentTitle(group ? `${group.name} (group)` : slug);

  if (loading && !data) {
    return (
      <div className="shell-content wide space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!group || members.length < 2) {
    return (
      <div className="shell-content wide text-center py-12">
        <h2 className="text-xl font-semibold">Group not found</h2>
        <p className="text-[var(--muted-foreground)] mt-2">
          No project group with slug &quot;{slug}&quot; — a group exists only while a repo is checked out in more than one
          scanned location.
        </p>
      </div>
    );
  }

  return (
    <div className="shell-content wide">
      <GroupDetail group={group} members={members} skippedRootPaths={skippedRootPaths} />
    </div>
  );
}
