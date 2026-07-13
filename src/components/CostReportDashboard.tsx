"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useUsage } from "@/hooks/useUsage";
import { useProjects } from "@/hooks/useProjects";
import { useCurrency } from "@/hooks/useCurrency";
import { COST_PERIODS } from "@/lib/usage/constants";
import { formatCost, formatTokens } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProjectBreakdown } from "@/lib/usage/types";
import type { ProjectData } from "@/lib/types";

const DEFAULT_PERIOD = "30d";

// Display name for a usage row. Prefer the scanned project's real name (from
// the route side, joined via usageSlug); fall back to decoding the encoded
// conversation dir (C--dev-my-app → my-app) for usage that has no matching
// scanned project (e.g. a bare `C:\dev` session or a temp dir).
function decodeDirName(encoded: string): string {
  const withoutDrive = encoded.replace(/^[A-Za-z]--/, ""); // "dev-my-app"
  const firstDash = withoutDrive.indexOf("-");
  return firstDash === -1 ? withoutDrive : withoutDrive.slice(firstDash + 1);
}

type SortKey = "name" | "cost" | "tokens" | "turns";

export function CostReportDashboard() {
  const [period, setPeriod] = useState<string>(DEFAULT_PERIOD);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("cost");
  const [sortAsc, setSortAsc] = useState(false);

  const { data, loading } = useUsage(period);
  const { data: scan } = useProjects();
  const { currency, fxRate } = useCurrency();

  // Join usage rows to scanned projects by the precomputed usageSlug, so each
  // row can link to /project/<routeSlug>?tab=costs and show the real name.
  const routeByUsage = useMemo(() => {
    const m = new Map<string, ProjectData>();
    for (const p of scan?.projects ?? []) m.set(p.usageSlug, p);
    return m;
  }, [scan]);

  const rows = useMemo(() => {
    const byProject: ProjectBreakdown[] = data?.byProject ?? [];
    const q = query.trim().toLowerCase();
    const decorated = byProject.map((r) => {
      const routeProject = routeByUsage.get(r.projectSlug);
      const name = routeProject?.name ?? decodeDirName(r.projectDirName);
      return { ...r, name, routeSlug: routeProject?.slug };
    });
    const filtered = q
      ? decorated.filter((r) => r.name.toLowerCase().includes(q))
      : decorated;
    const dir = sortAsc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name) * dir;
      return (a[sortKey] - b[sortKey]) * dir;
    });
  }, [data, routeByUsage, query, sortKey, sortAsc]);

  const totals = useMemo(() => {
    return (data?.byProject ?? []).reduce(
      (acc, r) => {
        acc.cost += r.cost;
        acc.tokens += r.tokens;
        acc.turns += r.turns;
        return acc;
      },
      { cost: 0, tokens: 0, turns: 0 },
    );
  }, [data]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      // Text sorts default A→Z; numeric sorts default high→low.
      setSortAsc(key === "name");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <h1 style={{
          fontSize: "1.1rem", fontWeight: 700,
          color: "var(--text-primary)", fontFamily: "var(--font-body)",
          letterSpacing: "-0.01em", margin: 0,
        }}>
          Cost by project
        </h1>

        {/* Period switcher */}
        <div style={{
          display: "flex",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}>
          {COST_PERIODS.map((p, i) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              style={{
                padding: "5px 11px",
                fontSize: "0.72rem", fontFamily: "var(--font-body)",
                letterSpacing: "0.03em",
                color: period === p.value ? "var(--text-primary)" : "var(--text-secondary)",
                background: period === p.value ? "var(--bg-elevated)" : "transparent",
                border: "none",
                borderRight: i < COST_PERIODS.length - 1 ? "1px solid var(--border-subtle)" : "none",
                cursor: "pointer", lineHeight: 1,
                transition: "color 0.1s, background 0.1s",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {/* Project search */}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter projects…"
          style={{
            fontSize: "0.72rem", fontFamily: "var(--font-body)",
            color: "var(--text-primary)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            padding: "5px 10px", width: "180px",
          }}
        />
      </div>

      {/* ── Table ──────────────────────────────────────────────────────── */}
      {loading && !data ? (
        <Skeleton className="h-64" />
      ) : rows.length === 0 ? (
        <div style={{
          padding: "40px", textAlign: "center",
          color: "var(--text-muted)", fontSize: "0.8rem",
          fontFamily: "var(--font-body)",
        }}>
          No cost data for this period.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{
            width: "100%", borderCollapse: "collapse",
            fontFamily: "var(--font-mono)", fontSize: "0.74rem",
          }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                <Th label="Project" active={sortKey === "name"} asc={sortAsc} onClick={() => toggleSort("name")} align="left" />
                <Th label="Cost" active={sortKey === "cost"} asc={sortAsc} onClick={() => toggleSort("cost")} align="right" />
                <Th label="Share" align="right" />
                <Th label="Tokens" active={sortKey === "tokens"} asc={sortAsc} onClick={() => toggleSort("tokens")} align="right" />
                <Th label="Turns" active={sortKey === "turns"} asc={sortAsc} onClick={() => toggleSort("turns")} align="right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const share = totals.cost > 0 ? r.cost / totals.cost : 0;
                const nameCell = r.routeSlug ? (
                  <Link
                    href={`/project/${r.routeSlug}?tab=costs`}
                    style={{ color: "var(--text-primary)", textDecoration: "none" }}
                  >
                    {r.name}
                  </Link>
                ) : (
                  <span style={{ color: "var(--text-secondary)" }}>{r.name}</span>
                );
                return (
                  <tr key={r.projectSlug} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                    <td style={{ padding: "7px 10px", fontFamily: "var(--font-body)" }}>{nameCell}</td>
                    <td style={{ padding: "7px 10px", textAlign: "right", color: "var(--text-primary)" }}>
                      {formatCost(r.cost, currency, fxRate)}
                    </td>
                    <td style={{ padding: "7px 10px", textAlign: "right", color: "var(--text-muted)", width: "90px" }}>
                      <ShareBar share={share} />
                    </td>
                    <td style={{ padding: "7px 10px", textAlign: "right", color: "var(--text-secondary)" }}>
                      {formatTokens(r.tokens)}
                    </td>
                    <td style={{ padding: "7px 10px", textAlign: "right", color: "var(--text-secondary)" }}>
                      {r.turns.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "2px solid var(--border-subtle)", fontWeight: 700 }}>
                <td style={{ padding: "8px 10px", fontFamily: "var(--font-body)", color: "var(--text-primary)" }}>
                  {rows.length} project{rows.length === 1 ? "" : "s"}
                </td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--text-primary)" }}>
                  {formatCost(totals.cost, currency, fxRate)}
                </td>
                <td />
                <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--text-secondary)" }}>
                  {formatTokens(totals.tokens)}
                </td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--text-secondary)" }}>
                  {totals.turns.toLocaleString()}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ label, active, asc, onClick, align = "right" }: {
  label: string; active?: boolean; asc?: boolean; onClick?: () => void; align?: "left" | "right";
}) {
  return (
    <th
      onClick={onClick}
      style={{
        padding: "6px 10px", textAlign: align,
        fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.08em",
        textTransform: "uppercase", color: active ? "var(--text-primary)" : "var(--text-muted)",
        fontFamily: "var(--font-body)", whiteSpace: "nowrap",
        cursor: onClick ? "pointer" : "default", userSelect: "none",
      }}
    >
      {label}
      {active ? <span style={{ opacity: 0.7 }}>{asc ? " ▲" : " ▼"}</span> : null}
    </th>
  );
}

function ShareBar({ share }: { share: number }) {
  return (
    <div style={{
      display: "inline-block", width: "70px", height: "8px",
      background: "var(--bg-elevated)", borderRadius: "2px", overflow: "hidden",
      verticalAlign: "middle",
    }}>
      <div style={{
        width: `${Math.round(share * 100)}%`, height: "100%",
        background: "var(--accent)", borderRadius: "2px",
      }} />
    </div>
  );
}
