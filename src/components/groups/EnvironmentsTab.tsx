"use client";

import { useMemo } from "react";
import { useEnvironments } from "@/hooks/useEnvironments";
import { useHomeCatalogs } from "@/hooks/useHomeCatalogs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  diffEnvironments,
  homeForLocation,
  type EnvKind,
  type EnvironmentHome,
  type EnvironmentInventory,
} from "@/lib/environments/diff";
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
 * locations live under: user and plugin-provided agents and skills (from the
 * catalog, per home — #553), installed plugins, MCP server names. Repo-borne
 * `.claude/` catalogs are the same files in every checkout and are covered
 * by the repo-borne tabs' divergence flags; this tab is about what differs
 * per MACHINE.
 *
 * Each location joins to a home by `usageHomeKey` (a mapped WSL checkout)
 * or, when unpinned, to the primary home. Homes that could not be read this
 * cycle are listed, not hidden — a stopped WSL distro's home is exactly the
 * one whose absence explains a behaviour difference. A home whose catalog
 * could not be read is excluded from the comparison and said so, rather
 * than compared as empty and shown differing on every row.
 */
export function EnvironmentsTab({ members, labels }: { members: readonly ProjectData[]; labels: Labels }) {
  const { data, loading, error } = useEnvironments();

  const { homes, columns, unmapped, unavailable } = useMemo(() => {
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
    // Only the unreadable homes THIS group lives under. The payload covers
    // every configured home, and a stopped distro that owns none of these
    // members is not a gap in this comparison (Codex on #554).
    const memberKeys = new Set(members.map((m) => m.usageHomeKey).filter((k): k is string => k !== undefined));
    const unavailable = (data?.unavailable ?? []).filter((u) => memberKeys.has(u.key));
    return { homes, columns, unmapped, unavailable };
  }, [data, members, labels]);

  const homeKeys = useMemo(() => homes.map((h) => h.key), [homes]);
  const catalogs = useHomeCatalogs(homeKeys);

  const { compared, catalogErrors, catalogsLoading } = useMemo(() => {
    const compared: EnvironmentInventory[] = [];
    const catalogErrors: { home: EnvironmentHome; error: string }[] = [];
    let catalogsLoading = false;
    for (const h of homes) {
      const state = catalogs.get(h.key);
      if (!state || state.loading) {
        catalogsLoading = true;
        continue;
      }
      if (state.error !== undefined || !state.catalog) {
        catalogErrors.push({ home: h, error: state.error ?? "catalog unavailable" });
        continue;
      }
      compared.push({ ...h, agents: state.catalog.agents, skills: state.catalog.skills });
    }
    return { compared, catalogErrors, catalogsLoading };
  }, [homes, catalogs]);

  const diff = useMemo(() => diffEnvironments(compared), [compared]);

  if (loading && !data) return <Skeleton className="h-40" />;
  if (error || !data) {
    return <Empty>Could not load the Claude home inventory.</Empty>;
  }

  const unresolvedByHome = compared.map((h) => ({
    home: h,
    // Registry keys, not names: `github@official` and `github@community` are different plugins.
    plugins: h.plugins.filter((p) => p.unresolved).map((p) => p.id),
  })).filter((x) => x.plugins.length > 0);

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
        {unavailable.map((u) => (
          <DivergenceChip key={u.path} title={u.path}>
            {u.distro ? `WSL ${u.distro}` : u.path}: {u.reason}
          </DivergenceChip>
        ))}
        {catalogErrors.map(({ home, error }) => (
          <DivergenceChip key={home.key} title={`${home.path}: the agents/skills catalog for this home could not be read (${error}); it is left out of the comparison`}>
            {columns.get(home.key)!.join(" + ")}: catalog unavailable
          </DivergenceChip>
        ))}
      </div>

      {unresolvedByHome.map(({ home, plugins }) => (
        <p key={home.key} style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-body)", margin: 0 }}>
          {columns.get(home.key)!.join(" + ")}: {plugins.length === 1 ? "one plugin's" : `${plugins.length} plugins'`} contents cannot be
          read from this machine ({plugins.join(", ")}) — the registry records install paths in that home&apos;s own filesystem,
          and no path mapping in Settings covers them. Their agents and skills are missing from that column, not uninstalled.
        </p>
      ))}

      {homes.length === 0 ? (
        <Empty>No readable Claude home matched this group&apos;s locations.</Empty>
      ) : catalogsLoading && compared.length < homes.length - catalogErrors.length ? (
        <Skeleton className="h-40" />
      ) : compared.length === 0 ? (
        <Empty>No home&apos;s catalog could be read, so there is nothing to compare.</Empty>
      ) : (
        <>
          {compared.length === 1 && (
            <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-body)", margin: 0 }}>
              {homes.length === 1
                ? "Every location shares one Claude home, so there is nothing to diff — this is that home's inventory."
                : "Only one home's catalog could be read, so there is nothing to diff — this is that home's inventory."}
            </p>
          )}
          {compared.length > 1 && (
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
                    {compared.length > 1 && (
                      <thead>
                        <tr>
                          <th style={TH} />
                          {compared.map((h) => (
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
                          <td style={{ ...TD, color: r.uniform ? "var(--text-secondary)" : "var(--text-primary)", whiteSpace: "normal" }} title={r.id}>
                            <span style={{ whiteSpace: "nowrap" }}>
                              {r.label}
                              {r.pluginName !== undefined && (
                                <span style={{ marginLeft: "6px", fontSize: "0.62rem", color: "var(--text-muted)" }} title={`Provided by the ${r.pluginName} plugin`}>
                                  {r.pluginName}
                                </span>
                              )}
                              {!r.uniform && compared.length > 1 && (
                                <span style={{ marginLeft: "6px" }}>
                                  <DivergenceChip>differs</DivergenceChip>
                                </span>
                              )}
                            </span>
                            {r.description && (
                              <div style={{ fontSize: "0.66rem", fontFamily: "var(--font-body)", color: "var(--text-muted)", marginTop: "2px", maxWidth: "48ch" }}>
                                {r.description}
                              </div>
                            )}
                          </td>
                          {compared.length > 1 &&
                            compared.map((h) => {
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
                          {compared.length === 1 && (
                            <td style={{ ...TD, textAlign: "right", color: "var(--text-muted)" }}>{r.detailIn[compared[0].key] ?? ""}</td>
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
