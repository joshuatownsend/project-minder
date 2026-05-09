"use client";

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, Webhook } from "lucide-react";
import Link from "next/link";
import { useHooks } from "@/hooks/useHooks";
import { Pill, inlineCode, commandPreview } from "./config/primitives";
import { ApplyUnitButton } from "./ApplyUnitButton";
import type { HookSource } from "@/lib/types";

const SOURCE_OPTIONS = ["all", "project", "local", "user", "plugin"] as const;
type SourceFilter = (typeof SOURCE_OPTIONS)[number];

const SORT_OPTIONS = [
  { value: "event", label: "Event" },
  { value: "project", label: "Project" },
] as const;
type SortBy = (typeof SORT_OPTIONS)[number]["value"];

export function HooksBrowser() {
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("event");
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), 300);
    return () => clearTimeout(t);
  }, [rawQuery]);

  const { data: allHooks, loading, error } = useHooks();

  const filtered = allHooks.filter((h) => {
    if (sourceFilter !== "all" && h.source !== sourceFilter) return false;
    if (query) {
      const q = query.toLowerCase();
      const text = [h.event, h.matcher ?? "", h.commands[0]?.command ?? "", h.projectName ?? ""].join(" ").toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "project") {
      const pa = a.projectName ?? "";
      const pb = b.projectName ?? "";
      if (pa !== pb) return pa.localeCompare(pb);
    }
    return a.event.localeCompare(b.event);
  });

  // Coverage matrix counts
  const projectCount = allHooks.filter((h) => h.source === "project").length;
  const localCount = allHooks.filter((h) => h.source === "local").length;
  const userCount = allHooks.filter((h) => h.source === "user").length;
  const pluginCount = allHooks.filter((h) => h.source === "plugin").length;

  const uniqueEvents = new Set(allHooks.map((h) => h.event)).size;

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 8,
    getItemKey: (i) => `${sorted[i].unitKey}-${i}`,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <Webhook style={{ width: "14px", height: "14px", color: "var(--text-muted)" }} />
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
          Hooks
        </h1>
      </header>

      {/* Coverage matrix */}
      {!loading && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            gap: "8px",
          }}
        >
          {[
            { label: "Project", count: projectCount, source: "project" as HookSource },
            { label: "Local", count: localCount, source: "local" as HookSource },
            { label: "User", count: userCount, source: "user" as HookSource },
            { label: "Plugin", count: pluginCount, source: "plugin" as HookSource },
            { label: "Events", count: uniqueEvents, source: null },
          ].map(({ label, count, source }) => (
            <button
              key={label}
              onClick={() => source && setSourceFilter((f) => f === source ? "all" : source)}
              style={{
                padding: "10px 12px",
                background:
                  source && sourceFilter === source
                    ? "var(--info-bg)"
                    : "var(--surface-2)",
                border: `1px solid ${source && sourceFilter === source ? "var(--info-border, var(--info))" : "var(--border)"}`,
                borderRadius: "var(--radius)",
                cursor: source ? "pointer" : "default",
                textAlign: "left",
              }}
            >
              <div
                style={{
                  fontSize: "1.2rem",
                  fontWeight: 700,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-primary)",
                  lineHeight: 1,
                }}
              >
                {count}
              </div>
              <div
                style={{
                  fontSize: "0.65rem",
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-body)",
                  marginTop: "3px",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                {label}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <div
          style={{
            position: "relative",
            flex: 1,
            maxWidth: "340px",
          }}
        >
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
            placeholder="Search hooks…"
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

        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
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
          {SOURCE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All sources" : s}
            </option>
          ))}
        </select>

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
          {sorted.length} hook{sorted.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Error */}
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

      {/* Virtualised list */}
      {loading ? (
        <LoadingSkeleton />
      ) : sorted.length === 0 ? (
        <Empty query={rawQuery} />
      ) : (
        <div
          ref={parentRef}
          style={{ height: "600px", overflowY: "auto" }}
        >
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
            {virtualizer.getVirtualItems().map((vItem) => {
              const h = sorted[vItem.index];
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
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "7px 0",
                    borderBottom: "1px solid var(--border-subtle)",
                  }}
                >
                  <Pill tone="info">{h.event}</Pill>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: "0.72rem",
                      display: "inline-flex",
                      gap: "6px",
                      alignItems: "center",
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {h.matcher && <code style={inlineCode}>{h.matcher}</code>}
                    <span
                      style={{
                        color: "var(--text-secondary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {commandPreview(h.commands[0]?.command, h.commands.length)}
                    </span>
                  </span>
                  {h.source === "local" && <LocalScopeBadge />}
                  {h.projectSlug ? (
                    <ApplyUnitButton
                      unit={{ kind: "hook", key: h.unitKey }}
                      source={{ kind: "project", slug: h.projectSlug }}
                      excludeTargetSlugs={[h.projectSlug]}
                      compact
                    />
                  ) : h.source === "user" ? (
                    <ApplyUnitButton
                      unit={{ kind: "hook", key: h.unitKey }}
                      source={{ kind: "user" }}
                      compact
                    />
                  ) : null}
                  <SourceBadge projectSlug={h.projectSlug} projectName={h.projectName} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function LocalScopeBadge() {
  return (
    <span
      title=".claude/settings.local.json — per-machine; copying via Template Mode auto-promotes to settings.json (project-shared)"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        color: "var(--warning, #f59e0b)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "3px",
        padding: "1px 5px",
        letterSpacing: "0.04em",
      }}
    >
      local
    </span>
  );
}

function SourceBadge({
  projectSlug,
  projectName,
}: {
  projectSlug?: string;
  projectName?: string;
}) {
  if (!projectSlug || !projectName) {
    return (
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.6rem",
          color: "var(--text-muted)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "3px",
          padding: "1px 5px",
        }}
      >
        user
      </span>
    );
  }
  return (
    <Link
      href={`/project/${projectSlug}`}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        color: "var(--info)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "3px",
        padding: "1px 5px",
        textDecoration: "none",
      }}
      title={`project: ${projectName}`}
    >
      {projectName}
    </Link>
  );
}

function LoadingSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: "40px",
            borderRadius: "var(--radius)",
            background: "var(--surface-2)",
            opacity: 1 - i * 0.1,
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
      {query ? `No hooks match "${query}"` : "No hooks configured."}
    </div>
  );
}
