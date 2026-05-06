"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, FileText, ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePlans, fetchPlanBody } from "@/hooks/usePlans";
import { formatRelativeTime } from "@/lib/utils";
import type { PlanEntry } from "@/lib/types";

const SORT_OPTIONS = [
  { value: "mtime", label: "Modified" },
  { value: "title", label: "Title" },
] as const;
type SortBy = (typeof SORT_OPTIONS)[number]["value"];

type BodyState = { state: "idle" } | { state: "loading" } | { state: "done"; body: string };

export function PlansBrowser() {
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<SortBy>("mtime");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [bodiesById, setBodiesById] = useState<Map<string, BodyState>>(new Map());
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), 300);
    return () => clearTimeout(t);
  }, [rawQuery]);

  const { data: plans, loading, error } = usePlans({ q: query || undefined });

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const p of plans) {
      for (const t of p.tags) set.add(t);
    }
    return Array.from(set).sort();
  }, [plans]);

  const filtered = tagFilter === "all"
    ? plans
    : plans.filter((p) => p.tags.includes(tagFilter));

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "title") return a.title.localeCompare(b.title);
    return b.mtime.localeCompare(a.mtime);
  });

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 6,
    getItemKey: (i) => sorted[i].slug,
  });

  function toggleExpand(slug: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
        if (!bodiesById.has(slug)) {
          setBodiesById((m) => new Map(m).set(slug, { state: "loading" }));
          fetchPlanBody(slug)
            .then((body) => {
              setBodiesById((m) =>
                new Map(m).set(slug, { state: "done", body: body ?? "" })
              );
            })
            .catch(() => {
              setBodiesById((m) =>
                new Map(m).set(slug, { state: "done", body: "" })
              );
            });
        }
      }
      return next;
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <FileText style={{ width: "14px", height: "14px", color: "var(--text-muted)" }} />
        <h1
          style={{
            fontSize: "0.72rem",
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-body)",
            margin: 0,
          }}
        >
          Plans
        </h1>
        <span
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}
        >
          ~/.claude/plans/
        </span>
      </header>

      {/* Filters */}
      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: "340px" }}>
          <Search
            style={{
              position: "absolute",
              left: "8px",
              top: "50%",
              transform: "translateY(-50%)",
              width: "12px",
              height: "12px",
              color: "var(--text-muted)",
              pointerEvents: "none",
            }}
          />
          <input
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder="Search plans…"
            style={{
              width: "100%",
              padding: "6px 8px 6px 26px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              fontSize: "0.78rem",
              fontFamily: "var(--font-body)",
              color: "var(--text-primary)",
              outline: "none",
            }}
          />
        </div>

        {allTags.length > 0 && (
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            style={{
              padding: "5px 8px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              fontSize: "0.75rem",
              fontFamily: "var(--font-body)",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            <option value="all">All tags</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortBy)}
          style={{
            padding: "5px 8px",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            fontSize: "0.75rem",
            fontFamily: "var(--font-body)",
            color: "var(--text-secondary)",
            cursor: "pointer",
          }}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              Sort: {o.label}
            </option>
          ))}
        </select>

        <span
          style={{
            marginLeft: "auto",
            fontSize: "0.72rem",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {sorted.length} plan{sorted.length !== 1 ? "s" : ""}
        </span>
      </div>

      {error && (
        <div
          style={{
            padding: "8px 12px",
            background: "var(--error-bg, #2a0000)",
            borderRadius: "var(--radius)",
            fontSize: "0.78rem",
            color: "var(--error, #f87171)",
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <LoadingSkeleton />
      ) : sorted.length === 0 ? (
        <Empty query={rawQuery} />
      ) : (
        <div ref={parentRef} style={{ overflowY: "auto", maxHeight: "70vh" }}>
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
            {virtualizer.getVirtualItems().map((vItem) => {
              const plan = sorted[vItem.index];
              const expanded = expandedIds.has(plan.slug);
              const bodyState = bodiesById.get(plan.slug) ?? { state: "idle" };
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
                    borderBottom: "1px solid var(--border-subtle)",
                  }}
                >
                  <PlanRow
                    plan={plan}
                    expanded={expanded}
                    onToggle={() => toggleExpand(plan.slug)}
                    bodyState={bodyState}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PlanRow({
  plan,
  expanded,
  onToggle,
  bodyState,
}: {
  plan: PlanEntry;
  expanded: boolean;
  onToggle: () => void;
  bodyState: BodyState;
}) {
  return (
    <div style={{ padding: "10px 0" }}>
      <div
        style={{ display: "flex", alignItems: "flex-start", gap: "8px", cursor: "pointer" }}
        onClick={onToggle}
      >
        <span style={{ marginTop: "3px", color: "var(--text-muted)", flexShrink: 0 }}>
          {expanded ? (
            <ChevronDown style={{ width: "12px", height: "12px" }} />
          ) : (
            <ChevronRight style={{ width: "12px", height: "12px" }} />
          )}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: "0.82rem",
                fontWeight: 600,
                color: "var(--text-primary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {plan.title}
            </span>
            {plan.tags.map((tag) => (
              <span
                key={tag}
                style={{
                  fontSize: "0.65rem",
                  fontFamily: "var(--font-mono)",
                  padding: "1px 6px",
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: "10px",
                  color: "var(--text-muted)",
                }}
              >
                {tag}
              </span>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              marginTop: "3px",
            }}
          >
            <span
              style={{
                fontSize: "0.68rem",
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {formatRelativeTime(plan.mtime)}
            </span>
            {plan.relatedSessionIds.length > 0 && (
              <span
                style={{
                  fontSize: "0.65rem",
                  color: "var(--info)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {plan.relatedSessionIds.length} session
                {plan.relatedSessionIds.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div
          style={{
            marginTop: "8px",
            paddingLeft: "20px",
            paddingBottom: "8px",
          }}
        >
          {bodyState.state === "loading" && (
            <div
              style={{ color: "var(--text-muted)", fontSize: "0.75rem", padding: "8px 0" }}
            >
              Loading…
            </div>
          )}
          {bodyState.state === "done" && (
            <>
              <pre
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.72rem",
                  color: "var(--text-secondary)",
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "10px 12px",
                  overflowX: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: "400px",
                  overflowY: "auto",
                }}
              >
                {bodyState.body || "(empty)"}
              </pre>
              {plan.relatedSessionIds.length > 0 && (
                <div
                  style={{
                    marginTop: "8px",
                    display: "flex",
                    gap: "6px",
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: "0.65rem",
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-body)",
                    }}
                  >
                    Related sessions:
                  </span>
                  {plan.relatedSessionIds.map((id) => (
                    <Link
                      key={id}
                      href={`/sessions/${id}`}
                      style={{
                        fontSize: "0.65rem",
                        fontFamily: "var(--font-mono)",
                        color: "var(--info)",
                        textDecoration: "none",
                      }}
                      title={id}
                    >
                      {id.slice(0, 8)}…
                    </Link>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: "54px",
            borderRadius: "var(--radius)",
            background: "var(--surface-2)",
            opacity: 1 - i * 0.12,
          }}
        />
      ))}
    </div>
  );
}

function Empty({ query }: { query: string }) {
  return (
    <div
      style={{
        padding: "40px 0",
        textAlign: "center",
        color: "var(--text-muted)",
        fontSize: "0.8rem",
        fontFamily: "var(--font-body)",
      }}
    >
      {query
        ? `No plans match "${query}"`
        : "No plans found in ~/.claude/plans/"}
    </div>
  );
}
