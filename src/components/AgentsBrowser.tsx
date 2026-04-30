"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAgents } from "@/hooks/useAgents";
import type { AgentRow } from "@/hooks/useAgents";
import { useUpdateStatuses } from "@/hooks/useUpdateStatuses";
import { Bot, Search, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import { ProvenanceBadge, ProvenanceDetails } from "@/components/ProvenanceBadge";
import { CatalogActionStrip } from "@/components/CatalogActionStrip";
import { formatRelativeTime } from "@/lib/utils";
import type { SkillUpdateStatus } from "@/lib/skillUpdateCache";

// Stable identity for a row across virtualizer remounts. Falls back through
// catalog id → orphan-usage name → flat-array index. Index is the unhappy
// fallback only — the first two cover ~100% of rows in practice.
function rowKey(row: AgentRow, idx: number): string {
  return row.entry?.id ?? `usage:${row.usage?.name ?? idx}`;
}

function AgentRowItem({
  row,
  updateStatus,
  expanded,
  onToggle,
  bodyFull,
  bodyFetched,
  onFetchBody,
}: {
  row: AgentRow;
  updateStatus?: SkillUpdateStatus;
  expanded: boolean;
  onToggle: () => void;
  bodyFull: string | null;
  // Distinguishes "not fetched yet" from "fetched and the body is empty."
  // Without this, an agent with a genuinely empty bodyFull would keep showing
  // the "View full body" button and re-fetching on every click.
  bodyFetched: boolean;
  onFetchBody: () => Promise<void>;
}) {
  const [bodyLoading, setBodyLoading] = useState(false);

  // Loading is transient and per-mount: when the row scrolls out of view the
  // virtualizer unmounts it; if the user scrolls back the parent's body cache
  // is still warm, so we just don't re-fetch.
  async function fetchBody() {
    if (bodyFetched || !row.entry?.id) return;
    setBodyLoading(true);
    try {
      await onFetchBody();
    } finally {
      setBodyLoading(false);
    }
  }

  const name = row.entry?.name ?? row.usage?.name ?? "Unknown";
  const description = row.entry?.description ?? "";
  const truncDesc =
    description.length > 160 ? description.slice(0, 160) + "…" : description;

  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--border-subtle)" }}>
      <div
        style={{ display: "flex", alignItems: "flex-start", gap: "8px", cursor: "pointer" }}
        onClick={onToggle}
      >
        <span style={{ marginTop: "2px", color: "var(--text-muted)", flexShrink: 0 }}>
          {expanded ? (
            <ChevronDown style={{ width: "12px", height: "12px" }} />
          ) : (
            <ChevronRight style={{ width: "12px", height: "12px" }} />
          )}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
              marginBottom: "3px",
            }}
          >
            <span
              style={{
                fontSize: "0.78rem",
                fontWeight: 600,
                color: "var(--text-primary)",
                fontFamily: "var(--font-body)",
              }}
            >
              {name}
            </span>
            {row.catalogMissing ? (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "3px", padding: "1px 5px" }}>
                plugin
              </span>
            ) : (
              <ProvenanceBadge provenance={row.entry?.provenance} hasUpdate={updateStatus?.hasUpdate} />
            )}
            {row.entry?.category && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.6rem",
                  color: "var(--text-muted)",
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "3px",
                  padding: "1px 5px",
                }}
              >
                {row.entry.category}
              </span>
            )}
            {row.entry?.model && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.6rem",
                  color: "var(--text-muted)",
                }}
              >
                {row.entry.model}
              </span>
            )}
          </div>
          {truncDesc && (
            <p
              style={{
                fontSize: "0.72rem",
                color: "var(--text-secondary)",
                margin: 0,
                lineHeight: 1.45,
                fontFamily: "var(--font-body)",
              }}
            >
              {truncDesc}
            </p>
          )}
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "2px",
            flexShrink: 0,
          }}
        >
          {row.usage && row.usage.invocations > 0 && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.65rem",
                fontWeight: 600,
                color: "var(--info)",
              }}
            >
              {row.usage.invocations}×
            </span>
          )}
          {row.usage?.lastUsed && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.6rem",
                color: "var(--text-muted)",
              }}
            >
              {formatRelativeTime(row.usage.lastUsed)}
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div
          style={{
            marginTop: "10px",
            marginLeft: "20px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          {row.entry?.tools && row.entry.tools.length > 0 && (
            <div
              style={{
                fontSize: "0.65rem",
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              tools: {row.entry.tools.join(", ")}
            </div>
          )}

          {row.entry?.provenance && (
            <ProvenanceDetails provenance={row.entry.provenance} />
          )}

          {row.entry && (
            <CatalogActionStrip entry={row.entry} updateStatus={updateStatus} />
          )}

          {row.entry?.bodyExcerpt && (
            <pre
              style={{
                fontSize: "0.68rem",
                color: "var(--text-secondary)",
                fontFamily: "var(--font-mono)",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius)",
                padding: "8px",
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: "140px",
                overflow: "hidden",
              }}
            >
              {bodyFull ?? row.entry.bodyExcerpt}
            </pre>
          )}

          {row.entry?.id && !bodyFetched && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                fetchBody();
              }}
              disabled={bodyLoading}
              style={{
                alignSelf: "flex-start",
                background: "transparent",
                border: "none",
                padding: 0,
                fontSize: "0.65rem",
                color: "var(--info)",
                cursor: "pointer",
                fontFamily: "var(--font-body)",
              }}
            >
              {bodyLoading ? "loading…" : "View full body →"}
            </button>
          )}

          {row.usage && row.usage.sessions.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
              {row.usage.sessions.slice(0, 5).map((sid) => (
                <Link
                  key={sid}
                  href={`/sessions/${sid}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "3px",
                    fontSize: "0.6rem",
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-muted)",
                    textDecoration: "none",
                  }}
                  onClick={(e: React.MouseEvent) => e.stopPropagation()}
                >
                  <ExternalLink style={{ width: "9px", height: "9px" }} />
                  {sid.slice(0, 8)}
                </Link>
              ))}
              {row.usage.sessions.length > 5 && (
                <span
                  style={{
                    fontSize: "0.6rem",
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  +{row.usage.sessions.length - 5} more
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type SortKey = "name" | "invocations" | "lastUsed";
type SourceFilter = "all" | "user" | "plugin" | "project";

export function AgentsBrowser() {
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [sortBy, setSortBy] = useState<SortKey>("invocations");
  const [hasUpdateOnly, setHasUpdateOnly] = useState(false);
  // Lifted state — survives virtualizer mount/unmount as the user scrolls.
  // Otherwise expanding a row, scrolling away, and scrolling back would
  // collapse it again, which feels like the page lost its place.
  //
  // Known quirk: filter changes don't prune `expandedIds`. If the user expands
  // some rows then narrows the filter, the expanded set retains keys that
  // aren't currently visible. The leaked entries are tiny strings and become
  // visible again as soon as the filter is widened, so we accept it.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // Map value: the fetched body text. `bodiesById.has(id)` is the
  // "fetched-or-not" predicate — distinguishing "fetched but empty" (`""`)
  // from "never fetched" (no entry). Mirrored to a ref so `fetchBodyFor`
  // can dedupe without taking `bodiesById` as a useCallback dep, which
  // would rotate the callback's identity on every successful fetch and
  // ripple into per-row re-renders.
  const [bodiesById, setBodiesById] = useState<Map<string, string>>(new Map());
  const bodiesByIdRef = useRef(bodiesById);
  bodiesByIdRef.current = bodiesById;

  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), 300);
    return () => clearTimeout(t);
  }, [rawQuery]);

  const { data, loading } = useAgents();
  const { statuses, pending } = useUpdateStatuses();

  const filtered = useMemo(() => {
    let rows = data;

    if (sourceFilter !== "all") {
      rows = rows.filter((r) => {
        if (r.catalogMissing) return sourceFilter === "plugin";
        return r.entry?.source === sourceFilter;
      });
    }

    if (hasUpdateOnly) {
      rows = rows.filter((r) => r.entry && statuses[r.entry.id]?.hasUpdate);
    }

    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter((r) => {
        const text = [
          r.entry?.name,
          r.entry?.description,
          r.entry?.category,
          r.entry?.pluginName,
          r.usage?.name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return text.includes(q);
      });
    }

    rows = [...rows].sort((a, b) => {
      if (sortBy === "name") {
        const an = a.entry?.name ?? a.usage?.name ?? "";
        const bn = b.entry?.name ?? b.usage?.name ?? "";
        return an.localeCompare(bn);
      }
      if (sortBy === "invocations") {
        return (b.usage?.invocations ?? 0) - (a.usage?.invocations ?? 0);
      }
      const at = a.usage?.lastUsed ?? "";
      const bt = b.usage?.lastUsed ?? "";
      return bt.localeCompare(at);
    });

    return rows;
  }, [data, sourceFilter, query, sortBy, hasUpdateOnly, statuses]);

  const total = data.length;
  const invoked = data.filter((r) => (r.usage?.invocations ?? 0) > 0).length;

  const toggleExpanded = useCallback((key: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const fetchBodyFor = useCallback(async (id: string) => {
    if (bodiesByIdRef.current.has(id)) return;
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}`);
    if (!res.ok) return;
    const data = await res.json();
    setBodiesById((prev) => {
      const next = new Map(prev);
      next.set(id, data.bodyFull ?? "");
      return next;
    });
  }, []);

  // Virtualization: 226 agents in this dataset, expandable detail panels make
  // the rendered tree large enough that React's diff cost dominates at full
  // expansion. Inner scroll container so each list page can size itself
  // without coupling to the page header layout — same pattern as
  // SessionsBrowser. estimateSize is a collapsed-row guess; measureElement
  // corrects after first paint and re-measures when expand/collapse fires.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 56,
    overscan: 6,
  });

  const segmentStyle = (active: boolean): React.CSSProperties => ({
    padding: "3px 9px",
    fontSize: "0.65rem",
    fontFamily: "var(--font-body)",
    fontWeight: active ? 600 : 400,
    color: active ? "var(--info)" : "var(--text-muted)",
    background: active ? "var(--info-bg)" : "transparent",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius)",
    cursor: "pointer",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <Bot style={{ width: "14px", height: "14px", color: "var(--text-muted)" }} />
        <h1
          style={{
            fontSize: "0.72rem",
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-body)",
          }}
        >
          Agents
        </h1>
        {total > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--text-muted)",
            }}
          >
            {total} total · {invoked} invoked
          </span>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 200px", minWidth: "160px" }}>
          <Search
            style={{
              position: "absolute",
              left: "9px",
              top: "50%",
              transform: "translateY(-50%)",
              width: "13px",
              height: "13px",
              color: "var(--text-muted)",
              pointerEvents: "none",
            }}
          />
          <input
            type="text"
            placeholder="Search agents…"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            style={{
              width: "100%",
              padding: "5px 9px 5px 28px",
              fontSize: "0.72rem",
              fontFamily: "var(--font-body)",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              color: "var(--text-primary)",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        <div style={{ display: "flex", gap: "3px" }}>
          {(["all", "user", "plugin", "project"] as SourceFilter[]).map((s) => (
            <button key={s} onClick={() => setSourceFilter(s)} style={segmentStyle(sourceFilter === s)}>
              {s}
            </button>
          ))}
        </div>

        <button
          onClick={() => setHasUpdateOnly((v) => !v)}
          style={{
            ...segmentStyle(hasUpdateOnly),
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: "5px",
              height: "5px",
              borderRadius: "50%",
              background: "var(--warning, #f59e0b)",
            }}
          />
          updates
          {pending > 0 && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", opacity: 0.6 }}>
              …
            </span>
          )}
        </button>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortKey)}
          style={{
            fontSize: "0.65rem",
            fontFamily: "var(--font-body)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            color: "var(--text-secondary)",
            padding: "4px 7px",
            cursor: "pointer",
          }}
        >
          <option value="invocations">Most invoked</option>
          <option value="lastUsed">Recently used</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {[...Array(6)].map((_, i) => (
            <div
              key={i}
              style={{
                height: "48px",
                background: "var(--bg-surface)",
                borderRadius: "var(--radius)",
                opacity: 0.5,
              }}
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "60px 20px",
            color: "var(--text-muted)",
          }}
        >
          <Bot style={{ width: "28px", height: "28px", opacity: 0.3, margin: "0 auto 8px" }} />
          <p style={{ fontSize: "0.75rem", fontFamily: "var(--font-body)" }}>
            {query || sourceFilter !== "all" ? "No agents match your filters." : "No agents found."}
          </p>
        </div>
      ) : (
        <div>
          <div
            style={{
              fontSize: "0.62rem",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              marginBottom: "4px",
            }}
          >
            {filtered.length} agent{filtered.length !== 1 ? "s" : ""}
          </div>
          <div
            ref={scrollContainerRef}
            style={{
              height: "calc(100vh - 260px)",
              minHeight: "400px",
              overflowY: "auto",
            }}
          >
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: "100%",
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((vItem) => {
                const row = filtered[vItem.index];
                const key = rowKey(row, vItem.index);
                const expanded = expandedIds.has(key);
                const bodyId = row.entry?.id;
                const bodyFetched = bodyId ? bodiesById.has(bodyId) : false;
                const bodyFull = bodyId && bodyFetched ? bodiesById.get(bodyId) ?? "" : null;
                return (
                  <div
                    key={vItem.key}
                    data-index={vItem.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vItem.start}px)`,
                    }}
                  >
                    <AgentRowItem
                      row={row}
                      updateStatus={row.entry ? statuses[row.entry.id] : undefined}
                      expanded={expanded}
                      onToggle={() => toggleExpanded(key)}
                      bodyFull={bodyFull}
                      bodyFetched={bodyFetched}
                      onFetchBody={() => (bodyId ? fetchBodyFor(bodyId) : Promise.resolve())}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
