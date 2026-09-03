"use client";

import { useMemo } from "react";
import { useEnvironments } from "@/hooks/useEnvironments";
import { Skeleton } from "@/components/ui/skeleton";
import { diffEnvironments, homeForLocation, type EnvKind, type EnvironmentHome } from "@/lib/environments/diff";
import type { ProjectData } from "@/lib/types";
import { DivergenceChip, LocationChip, type Labels } from "./PresenceChips";

const KIND_LABEL: Record<EnvKind, string> = {
  agent: "Agents",
  skill: "Skills",
  plugin: "Plugins",
  mcp: "MCP servers",
};

/**
 * Environment-borne state compared across the Claude homes the group's
 * locations live under: user agents, skills, installed plugins, MCP server
 * names. Repo-borne `.claude/` catalogs are the same files in every checkout
 * and are covered by the repo-borne tabs' divergence flags; this tab is
 * about what differs per MACHINE.
 *
 * Each location joins to a home by `usageHomeKey` (a mapped WSL checkout)
 * or, when unpinned, to the primary home. Homes that could not be read this
 * cycle are listed, not hidden — a stopped WSL distro's home is exactly the
 * one whose absence explains a behaviour difference.
 */
export function EnvironmentsTab({ members, labels }: { members: readonly ProjectData[]; labels: Labels }) {
  const { data, loading, error } = useEnvironments();

  const { homes, columns, unmapped } = useMemo(() => {
    const homes: EnvironmentHome[] = [];
    const columns = new Map<string, string[]>();
    const unmapped: string[] = [];
    for (const m of members) {
      const home = homeForLocation(m.usageHomeKey, data?.homes ?? []);
      if (!home) {
        unmapped.push(m.slug);
        continue;
      }
      if (!columns.has(home.key)) {
        homes.push(home);
        columns.set(home.key, []);
      }
      columns.get(home.key)!.push(labels[m.slug] ?? m.slug);
    }
    return { homes, columns, unmapped };
  }, [data, members, labels]);

  const diff = useMemo(() => diffEnvironments(homes), [homes]);

  if (loading && !data) return <Skeleton className="h-40" />;
  if (error || !data) {
    return <Empty>Could not load the Claude home inventory.</Empty>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        {homes.map((h) => (
          <span key={h.key} style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
            {columns.get(h.key)!.map((l) => (
              <LocationChip key={l}>{l}</LocationChip>
            ))}
            <span style={{ fontSize: "0.66rem", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }} title={h.path}>
              {h.primary ? "this machine" : h.path}
            </span>
          </span>
        ))}
        {unmapped.map((slug) => (
          <DivergenceChip key={slug} title="This location's Claude home was not read this cycle, or is no longer configured">
            {labels[slug] ?? slug}: home unavailable
          </DivergenceChip>
        ))}
        {data.unavailable.map((u) => (
          <DivergenceChip key={u.path} title={u.path}>
            {u.distro ? `WSL ${u.distro}` : u.path}: {u.reason}
          </DivergenceChip>
        ))}
      </div>

      {homes.length === 0 ? (
        <Empty>No readable Claude home matched this group&apos;s locations.</Empty>
      ) : (
        <>
          {homes.length === 1 && (
            <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-body)", margin: 0 }}>
              Every location shares one Claude home, so there is nothing to diff — this is that home&apos;s inventory.
            </p>
          )}
          {homes.length > 1 && (
            <p style={{ fontSize: "0.72rem", color: diff.divergent > 0 ? "var(--accent)" : "var(--text-muted)", fontFamily: "var(--font-body)", margin: 0 }}>
              {diff.divergent === 0
                ? "The compared homes have identical inventories."
                : `${diff.divergent} entr${diff.divergent === 1 ? "y" : "ies"} differ between the compared homes.`}
            </p>
          )}
          {diff.kinds.map((k) => (
            <section key={k.kind}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                <span
                  style={{
                    fontSize: "0.6rem",
                    fontWeight: 700,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-body)",
                  }}
                >
                  {KIND_LABEL[k.kind]}
                </span>
                <span style={{ fontSize: "0.62rem", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                  {k.rows.length}
                  {k.divergent > 0 ? ` · ${k.divergent} differ` : ""}
                </span>
                <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
              </div>
              {k.rows.length === 0 ? (
                <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", padding: "4px 0" }}>none</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.74rem", fontFamily: "var(--font-mono)" }}>
                    {homes.length > 1 && (
                      <thead>
                        <tr>
                          <th style={TH} />
                          {homes.map((h) => (
                            <th key={h.key} style={TH} title={h.path}>
                              {columns.get(h.key)!.join(" + ")}
                            </th>
                          ))}
                        </tr>
                      </thead>
                    )}
                    <tbody>
                      {k.rows.map((r) => (
                        <tr key={r.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                          <td style={{ ...TD, color: r.uniform ? "var(--text-secondary)" : "var(--text-primary)" }} title={r.id}>
                            {r.label}
                            {!r.uniform && homes.length > 1 && (
                              <span style={{ marginLeft: "6px" }}>
                                <DivergenceChip>differs</DivergenceChip>
                              </span>
                            )}
                          </td>
                          {homes.length > 1 &&
                            homes.map((h) => {
                              const present = r.presentIn.includes(h.key);
                              const detail = r.detailIn[h.key];
                              return (
                                <td
                                  key={h.key}
                                  style={{
                                    ...TD,
                                    textAlign: "center",
                                    color: present ? (detail ? "var(--accent)" : "var(--status-active-text)") : "var(--text-muted)",
                                  }}
                                >
                                  {present ? (detail ?? "✓") : "—"}
                                </td>
                              );
                            })}
                          {homes.length === 1 && (
                            <td style={{ ...TD, textAlign: "right", color: "var(--text-muted)" }}>{r.detailIn[homes[0].key] ?? ""}</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

const TH: React.CSSProperties = {
  textAlign: "center",
  fontWeight: 600,
  fontSize: "0.62rem",
  letterSpacing: "0.04em",
  color: "var(--text-muted)",
  padding: "4px 8px",
};

const TD: React.CSSProperties = {
  padding: "5px 8px",
  verticalAlign: "top",
  whiteSpace: "nowrap",
};

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem", fontFamily: "var(--font-body)" }}>
      {children}
    </div>
  );
}
