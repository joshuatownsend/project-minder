"use client";

import Link from "next/link";
import { GitBranch } from "lucide-react";
import { DevServerControl } from "@/components/DevServerControl";
import { StatusBadge } from "@/components/StatusBadge";
import { formatRelativeTime } from "@/lib/utils";
import type { GroupLocation } from "@/lib/groups/aggregate";
import type { ProjectData } from "@/lib/types";
import { DivergenceChip, LocationChip, type Labels } from "./PresenceChips";

/**
 * The per-checkout strip: path, branch, dirty count, dev-server state, and
 * last activity for every location side by side — the plan's "drill into
 * each root path" requirement. Location-bound state is never merged, so this
 * is the one place on the group page that shows raw member values.
 *
 * `members` supplies what `GroupLocation` deliberately omits (the full
 * `ProjectData` is already in the page's scope): `DevServerControl` needs the
 * member's path and port, and the link target is the member's own page.
 */
export function LocationsStrip({
  locations,
  members,
  labels,
  primary,
}: {
  locations: readonly GroupLocation[];
  members: readonly ProjectData[];
  labels: Labels;
  primary: string;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(280px, 1fr))`,
        gap: "10px",
      }}
    >
      {locations.map((loc) => {
        const member = members.find((m) => m.slug === loc.slug);
        return (
          <div
            key={loc.slug}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              padding: "12px 14px",
              background: "var(--bg-elevated)",
              border: loc.stale ? "1px solid var(--accent-border)" : "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              minWidth: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
              <LocationChip>{labels[loc.slug] ?? loc.slug}</LocationChip>
              {loc.slug === primary && (
                <span
                  title="Headline values on this page come from this location (most recent activity)"
                  style={{ fontSize: "0.6rem", fontFamily: "var(--font-mono)", color: "var(--text-muted)", letterSpacing: "0.04em" }}
                >
                  PRIMARY
                </span>
              )}
              {loc.stale && (
                <DivergenceChip title="Its scan root was skipped this pass (a stopped WSL distro, say); these are last-known values">
                  stale
                </DivergenceChip>
              )}
              <div style={{ flex: 1 }} />
              <StatusBadge status={loc.status} />
            </div>

            <Link
              href={`/project/${loc.slug}`}
              title={loc.path}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.68rem",
                color: "var(--text-secondary)",
                textDecoration: "none",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {loc.path}
            </Link>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                flexWrap: "wrap",
                fontFamily: "var(--font-mono)",
                fontSize: "0.68rem",
                color: "var(--text-muted)",
              }}
            >
              {loc.branch && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                  <GitBranch style={{ width: "10px", height: "10px" }} />
                  {loc.branch}
                </span>
              )}
              {loc.gitUnknown ? (
                <span title="The dirty check failed for this checkout">dirty: unknown</span>
              ) : loc.isDirty ? (
                <span style={{ color: "var(--accent)" }} title={`${loc.uncommittedCount} uncommitted change(s)`}>
                  +{loc.uncommittedCount}
                </span>
              ) : (
                <span>clean</span>
              )}
              {loc.worktrees.length > 0 && (
                <span style={{ color: "var(--info)" }} title={loc.worktrees.map((w) => w.branch).join(", ")}>
                  wt {loc.worktrees.length}
                </span>
              )}
              <span title={loc.lastActivity ?? "no recorded activity"}>
                {loc.lastActivity ? formatRelativeTime(loc.lastActivity) : "no activity"}
              </span>
              <span title="Claude Code sessions attributed to this checkout">
                {loc.sessionCount} session{loc.sessionCount === 1 ? "" : "s"}
              </span>
            </div>

            {member && (
              <div onClick={(e) => e.stopPropagation()}>
                <DevServerControl slug={member.slug} projectPath={member.path} devPort={member.devPort} compact />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
