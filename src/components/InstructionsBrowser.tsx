"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { ScrollText, Search, ChevronDown, ChevronRight } from "lucide-react";
import type { Provenance } from "@/lib/indexer/types";
import { CatalogLintChip } from "@/components/CatalogLintChip";
import { formatRelativeTime, truncate } from "@/lib/utils";
import { formatProjectedContextCost } from "@/lib/usage/tokenEstimate";

// Mirror of InstructionEntry (src/lib/indexer/types.ts) as it crosses the
// /api/instructions wire. Kept as a local interface — like useAgents'
// AgentRow.entry — so the client component doesn't import server indexer
// internals beyond the shared Provenance union.
interface InstructionRow {
  id: string;
  slug: string;
  name: string;
  description?: string;
  harness: "claude" | "codex" | "gemini";
  kind: "instruction";
  source: "user" | "plugin" | "project";
  pluginName?: string;
  projectSlug?: string;
  category?: string;
  filePath: string;
  bodyExcerpt: string;
  frontmatter: Record<string, unknown>;
  mtime: string;
  ctime: string;
  provenance: Provenance;
  parseWarnings?: string[];
  fileBytes?: number;
  projectedContextCost?: { tokenEstimate: number; contextWindowPercent: number };
}

type SortKey = "name" | "mtime" | "size";
type HarnessFilter = "all" | "codex" | "gemini" | "claude";
type SourceFilter = "all" | "user" | "plugin" | "project";

const HARNESS_LABEL: Record<InstructionRow["harness"], string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
};

function chip(extra?: React.CSSProperties): React.CSSProperties {
  return {
    fontFamily: "var(--font-mono)",
    fontSize: "0.6rem",
    color: "var(--text-muted)",
    background: "var(--bg-surface)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "3px",
    padding: "1px 5px",
    ...extra,
  };
}

function InstructionRowItem({
  row,
  expanded,
  onToggle,
}: {
  row: InstructionRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const truncDesc = truncate(row.description ?? "");
  const costChip = formatProjectedContextCost(row.projectedContextCost);
  // Frontmatter keys worth surfacing inline — skip the noisy/internal ones
  // already rendered as their own fields (name/description).
  const fmEntries = Object.entries(row.frontmatter).filter(
    ([k]) => k !== "name" && k !== "description",
  );

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
              {row.name}
            </span>
            <span style={chip({ color: "var(--info)", borderColor: "var(--info)" })}>
              {HARNESS_LABEL[row.harness]}
            </span>
            {row.category && <span style={chip()}>{row.category}</span>}
            <span style={chip()}>{row.source}</span>
            {row.parseWarnings && row.parseWarnings.length > 0 && (
              <CatalogLintChip warnings={row.parseWarnings} />
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
          {costChip && (
            <span
              title={costChip.chipTitle}
              style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)" }}
            >
              {costChip.chipLabel}
            </span>
          )}
          {row.mtime && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)" }}>
              {formatRelativeTime(row.mtime)}
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
          <div
            style={{
              fontSize: "0.65rem",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              wordBreak: "break-all",
            }}
          >
            {row.filePath}
          </div>

          {fmEntries.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
              {fmEntries.map(([k, v]) => (
                <span key={k} style={chip()}>
                  {k}: {typeof v === "object" ? JSON.stringify(v) : String(v)}
                </span>
              ))}
            </div>
          )}

          {row.bodyExcerpt && (
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
                maxHeight: "200px",
                overflow: "auto",
              }}
            >
              {row.bodyExcerpt}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function InstructionsBrowser() {
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [harnessFilter, setHarnessFilter] = useState<HarnessFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [sortBy, setSortBy] = useState<SortKey>("name");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const [data, setData] = useState<InstructionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), 300);
    return () => clearTimeout(t);
  }, [rawQuery]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetch("/api/instructions")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((rows: InstructionRow[]) => {
        if (!cancelled) setData(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    let rows = data;

    if (harnessFilter !== "all") rows = rows.filter((r) => r.harness === harnessFilter);
    if (sourceFilter !== "all") rows = rows.filter((r) => r.source === sourceFilter);

    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter((r) => {
        const text = [r.name, r.description, r.category, r.harness, r.pluginName]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return text.includes(q);
      });
    }

    rows = [...rows].sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "size") return (b.fileBytes ?? 0) - (a.fileBytes ?? 0);
      return (b.mtime ?? "").localeCompare(a.mtime ?? "");
    });

    return rows;
  }, [data, harnessFilter, sourceFilter, query, sortBy]);

  const total = data.length;

  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
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

  // Distinct from "no results after filtering" — the common case is an empty
  // catalog because no non-Claude adapter is enabled (default config). Only
  // the unfiltered-empty case earns the opt-in explainer; an empty filtered
  // view over a populated catalog gets the plain "no match" message.
  const catalogEmpty = !loading && !error && total === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <ScrollText style={{ width: "14px", height: "14px", color: "var(--text-muted)" }} />
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
          Instructions
        </h1>
        {total > 0 && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
            {total} total
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
            placeholder="Search instructions…"
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
          {(["all", "codex", "gemini", "claude"] as HarnessFilter[]).map((h) => (
            <button key={h} onClick={() => setHarnessFilter(h)} style={segmentStyle(harnessFilter === h)}>
              {h}
            </button>
          ))}
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
          <option value="name">Name A–Z</option>
          <option value="mtime">Recently modified</option>
          <option value="size">Largest</option>
        </select>
      </div>

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {[...Array(5)].map((_, i) => (
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
      ) : error ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-muted)" }}>
          <ScrollText style={{ width: "28px", height: "28px", opacity: 0.3, margin: "0 auto 8px" }} />
          <p style={{ fontSize: "0.75rem", fontFamily: "var(--font-body)" }}>
            Couldn’t load the instruction catalog. Try reloading the page.
          </p>
        </div>
      ) : catalogEmpty ? (
        <div
          style={{
            textAlign: "center",
            padding: "56px 24px",
            color: "var(--text-muted)",
            maxWidth: "520px",
            margin: "0 auto",
          }}
        >
          <ScrollText style={{ width: "30px", height: "30px", opacity: 0.35, margin: "0 auto 12px" }} />
          <p
            style={{
              fontSize: "0.82rem",
              fontWeight: 600,
              color: "var(--text-secondary)",
              fontFamily: "var(--font-body)",
              margin: "0 0 8px",
            }}
          >
            No harness instructions yet
          </p>
          <p style={{ fontSize: "0.74rem", lineHeight: 1.55, fontFamily: "var(--font-body)", margin: "0 0 16px" }}>
            This catalog surfaces harness-native instruction files — Codex{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>rules</code>,{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>AGENTS.md</code>, and{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>prompts</code>, plus the Gemini{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>GEMINI.md</code> context file. It’s read-only and
            opt-in: enable Codex or Gemini under Adapters to populate it.
          </p>
          <Link
            href="/settings/adapters"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              fontSize: "0.72rem",
              fontWeight: 600,
              fontFamily: "var(--font-body)",
              color: "var(--info)",
              background: "var(--info-bg)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              padding: "6px 12px",
              textDecoration: "none",
            }}
          >
            Enable an adapter →
          </Link>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-muted)" }}>
          <ScrollText style={{ width: "28px", height: "28px", opacity: 0.3, margin: "0 auto 8px" }} />
          <p style={{ fontSize: "0.75rem", fontFamily: "var(--font-body)" }}>
            No instructions match your filters.
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
            {filtered.length} instruction{filtered.length !== 1 ? "s" : ""}
          </div>
          <div>
            {filtered.map((row) => (
              <InstructionRowItem
                key={row.id}
                row={row}
                expanded={expandedIds.has(row.id)}
                onToggle={() => toggleExpanded(row.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
