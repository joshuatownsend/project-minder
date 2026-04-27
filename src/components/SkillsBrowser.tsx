"use client";

import { useState, useMemo, useEffect } from "react";
import { useSkills, type SkillRow } from "@/hooks/useSkills";
import { Wrench, Search, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import Link from "next/link";

function formatDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return "—";
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

function SourceBadge({ row }: { row: SkillRow }) {
  const source = row.entry?.source ?? "plugin";
  const label = row.catalogMissing
    ? `plugin (${row.usage?.name?.split(":")[0] ?? "?"})`
    : source === "plugin"
    ? `plugin: ${row.entry?.pluginName ?? ""}`
    : source;
  const color =
    source === "user"
      ? "var(--text-secondary)"
      : source === "plugin"
      ? "var(--accent)"
      : "var(--success, #4ade80)";

  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        color,
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "3px",
        padding: "1px 5px",
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

function SkillRow({ row }: { row: SkillRow }) {
  const [expanded, setExpanded] = useState(false);
  const [bodyFull, setBodyFull] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);

  const name = row.entry?.name ?? row.usage?.name ?? "Unknown";
  const description = row.entry?.description ?? "";
  const truncDesc =
    description.length > 160 ? description.slice(0, 160) + "…" : description;

  async function fetchBody() {
    if (bodyFull !== null || !row.entry?.id) return;
    setBodyLoading(true);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(row.entry.id)}`);
      if (res.ok) {
        const data = await res.json();
        setBodyFull(data.bodyFull ?? "");
      }
    } finally {
      setBodyLoading(false);
    }
  }

  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--border-subtle)" }}>
      <div
        style={{ display: "flex", alignItems: "flex-start", gap: "8px", cursor: "pointer" }}
        onClick={() => setExpanded((v) => !v)}
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
            <SourceBadge row={row} />
            {row.entry?.userInvocable && (
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
                /{row.entry.argumentHint ?? row.entry.slug}
              </span>
            )}
            {row.entry?.version && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.6rem",
                  color: "var(--text-muted)",
                }}
              >
                v{row.entry.version}
              </span>
            )}
            {row.entry?.layout === "standalone" && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.6rem",
                  color: "var(--text-muted)",
                  opacity: 0.7,
                }}
              >
                standalone
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
                color: "var(--accent)",
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
              {formatDate(row.usage.lastUsed)}
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

          {row.entry?.id && bodyFull === null && (
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
                color: "var(--accent)",
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

export function SkillsBrowser() {
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [sortBy, setSortBy] = useState<SortKey>("invocations");

  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), 300);
    return () => clearTimeout(t);
  }, [rawQuery]);

  const { data, loading } = useSkills();

  const filtered = useMemo(() => {
    let rows = data;

    if (sourceFilter !== "all") {
      rows = rows.filter((r) => {
        if (r.catalogMissing) return sourceFilter === "plugin";
        return r.entry?.source === sourceFilter;
      });
    }

    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter((r) => {
        const text = [
          r.entry?.name,
          r.entry?.description,
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
  }, [data, sourceFilter, query, sortBy]);

  const total = data.length;
  const invoked = data.filter((r) => (r.usage?.invocations ?? 0) > 0).length;

  const segmentStyle = (active: boolean): React.CSSProperties => ({
    padding: "3px 9px",
    fontSize: "0.65rem",
    fontFamily: "var(--font-body)",
    fontWeight: active ? 600 : 400,
    color: active ? "var(--accent)" : "var(--text-muted)",
    background: active ? "var(--accent-bg)" : "transparent",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius)",
    cursor: "pointer",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <Wrench style={{ width: "14px", height: "14px", color: "var(--text-muted)" }} />
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
          Skills
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
            placeholder="Search skills…"
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
          <Wrench style={{ width: "28px", height: "28px", opacity: 0.3, margin: "0 auto 8px" }} />
          <p style={{ fontSize: "0.75rem", fontFamily: "var(--font-body)" }}>
            {query || sourceFilter !== "all" ? "No skills match your filters." : "No skills found."}
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
            {filtered.length} skill{filtered.length !== 1 ? "s" : ""}
          </div>
          {filtered.map((row, i) => (
            <SkillRow key={row.entry?.id ?? row.usage?.name ?? i} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
