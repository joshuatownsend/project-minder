"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { StatusCard } from "./StatusCard";
import type { LiveSession, LiveSessionStatus } from "@/lib/types";
// Use the canonical payload type rather than a local copy. The local interface
// previously omitted `cliAvailable`, so the `as StatusPayload` cast at the
// fetch site hid the field from TypeScript (the runtime JSON still carries it).
// Importing the source of truth keeps this component in sync as the payload evolves.
import type { StatusPayload } from "@/lib/liveStatus";

const BUCKET_CONFIG: { status: LiveSessionStatus; label: string; color: string }[] = [
  { status: "approval", label: "Needs Approval",      color: "var(--accent)" },
  { status: "working",  label: "Working",              color: "#4ade80" },
  { status: "waiting",  label: "Waiting for You",      color: "#60a5fa" },
  { status: "other",    label: "Other / Stale",        color: "var(--text-muted)" },
];

function SectionHeader({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: "6px", height: "6px", borderRadius: "50%",
        background: color, flexShrink: 0,
      }} />
      <span style={{
        fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.08em",
        textTransform: "uppercase", color: "var(--text-muted)",
        fontFamily: "var(--font-body)",
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: "0.65rem",
        color: "var(--text-muted)",
      }}>
        {count}
      </span>
      <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
    </div>
  );
}

export function StatusDashboard() {
  // Migrated from a 3s setInterval loop to useQuery (C2). `refetchInterval`
  // keeps the 3s cadence; `refetchIntervalInBackground: false` pauses it on a
  // hidden tab. A failed poll keeps the last good payload (TanStack retains
  // `data` across a background refetch error), matching the old silent catch.
  const { data = null, isPending: loading } = useQuery({
    queryKey: queryKeys.liveStatus(),
    queryFn: async ({ signal }): Promise<StatusPayload> => {
      const res = await fetch("/api/status", { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
  });

  const buckets = useMemo(() => {
    const b: Record<LiveSessionStatus, LiveSession[]> = { approval: [], working: [], waiting: [], other: [] };
    data?.sessions.forEach((s) => b[s.status].push(s));
    return b;
  }, [data]);

  const lastUpdated = data?.generatedAt
    ? new Date(data.generatedAt).toLocaleTimeString()
    : null;

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {[...Array(4)].map((_, i) => (
          <div key={i} style={{
            height: "44px", borderRadius: "var(--radius)",
            background: "var(--bg-surface)",
            animation: "pulse 1.5s ease-in-out infinite",
          }} />
        ))}
      </div>
    );
  }

  const total = data?.sessions.length ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{
            fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)",
            fontFamily: "var(--font-body)", margin: "0 0 4px",
          }}>
            System Status
          </h1>
          <p style={{
            fontSize: "0.75rem", color: "var(--text-muted)", margin: 0,
            fontFamily: "var(--font-body)",
          }}>
            {total === 0
              ? "No active Claude Code sessions in the last 4 hours"
              : `${total} session${total !== 1 ? "s" : ""} found in the last 4 hours`}
          </p>
        </div>
        {lastUpdated && (
          <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            updated {lastUpdated}
          </span>
        )}
      </div>

      {/* Buckets */}
      {BUCKET_CONFIG.map(({ status, label, color }) => {
        const sessions = buckets[status];
        if (sessions.length === 0) return null;
        return (
          <div key={status}>
            <SectionHeader label={label} count={sessions.length} color={color} />
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {sessions.map((s) => (
                <StatusCard key={s.sessionId} session={s} />
              ))}
            </div>
          </div>
        );
      })}

      {total === 0 && (
        <div style={{
          padding: "48px 0", textAlign: "center",
          fontSize: "0.8rem", color: "var(--text-muted)",
          fontFamily: "var(--font-body)",
        }}>
          No recent sessions. Start a Claude Code session in any project to see it here.
        </div>
      )}
    </div>
  );
}
