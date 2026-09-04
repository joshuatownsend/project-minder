"use client";

import Link from "next/link";
import { ProjectSessions } from "@/components/ProjectSessions";
import { StatCell } from "@/components/ui/StatCell";
import { formatRelativeTime } from "@/lib/utils";
import type { GroupActivity } from "@/lib/groups/aggregate";
import type { ProjectData } from "@/lib/types";
import { LocationChip, type Labels } from "./PresenceChips";

/**
 * Sessions across the group: the summed count is the headline, then one
 * session list per location. `activity.perLocation` (from the aggregate,
 * no fetch) supplies the counts; the lists come from `ProjectSessions`,
 * which is keyed on the member's `usageDirName` — a field the aggregate
 * deliberately does not carry, so it is read off the full `ProjectData`.
 */
export function GroupSessionsTab({
  activity,
  members,
  labels,
}: {
  activity: GroupActivity;
  members: readonly ProjectData[];
  labels: Labels;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
        <StatCell label="Sessions" value={activity.sessionCount.toLocaleString()} detail="all locations" />
        <StatCell
          label="Last session"
          value={activity.lastSessionDate ? formatRelativeTime(activity.lastSessionDate) : "—"}
          detail={activity.mostRecent ? labels[activity.mostRecent.slug] ?? activity.mostRecent.slug : undefined}
        />
        {activity.perLocation.map((loc) => (
          <StatCell
            key={loc.slug}
            label={labels[loc.slug] ?? loc.slug}
            value={loc.sessionCount.toLocaleString()}
            detail={loc.lastSessionDate ? formatRelativeTime(loc.lastSessionDate) : "no sessions"}
          />
        ))}
      </div>

      {members.map((m) => (
        <section key={m.slug}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
            <LocationChip>{labels[m.slug] ?? m.slug}</LocationChip>
            <Link
              href={`/project/${m.slug}?tab=sessions`}
              style={{ fontSize: "0.68rem", fontFamily: "var(--font-mono)", color: "var(--text-muted)", textDecoration: "none" }}
            >
              {m.path}
            </Link>
          </div>
          <ProjectSessions usageDirName={m.usageDirName} />
        </section>
      ))}
    </div>
  );
}
