"use client";

import { useEffect, useState } from "react";
import { isBuggyVersion } from "@/lib/usage/versionDetector";
import type { SessionSummary } from "@/lib/types";

interface VersionRow {
  version: string;
  sessionCount: number;
  firstSeen: string;
  lastSeen: string;
  isBuggy: boolean;
}

function buildVersionRows(sessions: SessionSummary[]): VersionRow[] {
  const map = new Map<string, { count: number; first: string; last: string }>();
  for (const s of sessions) {
    if (!s.cliVersion) continue;
    const ts = s.startTime ?? s.endTime ?? "";
    const existing = map.get(s.cliVersion);
    if (!existing) {
      map.set(s.cliVersion, { count: 1, first: ts, last: ts });
    } else {
      existing.count++;
      if (ts && (!existing.first || ts < existing.first)) existing.first = ts;
      if (ts && (!existing.last || ts > existing.last)) existing.last = ts;
    }
  }
  return Array.from(map.entries())
    .map(([version, { count, first, last }]) => ({
      version,
      sessionCount: count,
      firstSeen: first ? first.slice(0, 10) : "—",
      lastSeen: last ? last.slice(0, 10) : "—",
      isBuggy: isBuggyVersion(version),
    }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export function VersionHistoryPanel({ period, projectSlug }: { period: string; projectSlug?: string | null }) {
  const [rows, setRows] = useState<VersionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    setLoading(true);
    const url = `/api/sessions${projectSlug ? `?project=${projectSlug}` : ""}`;
    fetch(url)
      .then((r) => r.json() as Promise<{ sessions: SessionSummary[] }>)
      .then((d) => {
        const filtered = d.sessions.filter((s) => {
          if (period === "all") return true;
          const ts = s.startTime ?? s.endTime;
          if (!ts) return false;
          const now = Date.now();
          const t = new Date(ts).getTime();
          if (period === "today") return now - t < 86400_000;
          if (period === "week") return now - t < 7 * 86400_000;
          if (period === "month") return now - t < 30 * 86400_000;
          return true;
        });
        setRows(buildVersionRows(filtered));
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [period, projectSlug]);

  return (
    <div>
      <button
        onClick={() => setCollapsed((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: "6px",
          background: "none", border: "none", padding: "0 0 8px",
          cursor: "pointer", fontSize: "0.75rem", fontWeight: 600,
          color: "var(--text-secondary)", fontFamily: "var(--font-body)",
        }}
      >
        <span style={{ fontSize: "0.62rem", color: "var(--text-muted)" }}>{collapsed ? "▶" : "▼"}</span>
        CLI Version History
      </button>
      {!collapsed && (
        loading
          ? <p style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>Loading…</p>
          : rows.length === 0
            ? <p style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>No version data for this period.</p>
            : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.72rem" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                    {["Version", "Sessions", "First seen", "Last seen"].map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "4px 8px", fontWeight: 600, color: "var(--text-muted)", fontFamily: "var(--font-body)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.version} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                      <td style={{ padding: "5px 8px", fontFamily: "var(--font-mono)", color: r.isBuggy ? "var(--status-error-text)" : "var(--text-primary)" }}>
                        {r.version}
                        {r.isBuggy && <span style={{ marginLeft: "6px", fontSize: "0.62rem", background: "var(--status-error-bg)", color: "var(--status-error-text)", border: "1px solid var(--status-error-border)", borderRadius: "3px", padding: "1px 4px" }}>buggy</span>}
                      </td>
                      <td style={{ padding: "5px 8px", color: "var(--text-secondary)" }}>{r.sessionCount}</td>
                      <td style={{ padding: "5px 8px", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{r.firstSeen}</td>
                      <td style={{ padding: "5px 8px", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{r.lastSeen}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
      )}
    </div>
  );
}
