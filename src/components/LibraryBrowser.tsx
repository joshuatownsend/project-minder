"use client";

import { useState, useEffect, useMemo } from "react";
import { BookOpen, Search, ChevronDown, ChevronRight, Check } from "lucide-react";
import type { LibraryResponse, LibraryIndexItem } from "@/app/api/library/route";

const KIND_LABELS: Record<string, string> = { command: "Command", skill: "Skill", agent: "Agent" };
const KIND_COLORS: Record<string, string> = {
  command: "rgba(93,163,198,0.15)",
  skill: "rgba(34,197,94,0.12)",
  agent: "rgba(168,85,247,0.12)",
};
const KIND_TEXT: Record<string, string> = {
  command: "#5da3c6",
  skill: "#22c55e",
  agent: "#a855f7",
};

function KindChip({ kind }: { kind: string }) {
  return (
    <span style={{
      fontSize: "0.6rem", fontFamily: "var(--font-mono)", fontWeight: 600,
      letterSpacing: "0.06em", textTransform: "uppercase",
      background: KIND_COLORS[kind] ?? "var(--bg-elevated)",
      color: KIND_TEXT[kind] ?? "var(--text-muted)",
      border: `1px solid ${KIND_TEXT[kind] ?? "var(--border-subtle)"}30`,
      borderRadius: "3px", padding: "2px 5px", whiteSpace: "nowrap",
    }}>
      {KIND_LABELS[kind] ?? kind}
    </span>
  );
}

function TagChip({ tag }: { tag: string }) {
  return (
    <span style={{
      fontSize: "0.6rem", fontFamily: "var(--font-mono)",
      color: "var(--text-muted)", background: "var(--bg-elevated)",
      border: "1px solid var(--border-subtle)",
      borderRadius: "3px", padding: "2px 5px", whiteSpace: "nowrap",
    }}>
      {tag}
    </span>
  );
}

interface ApplyState {
  loading: boolean;
  ok?: boolean;
  message?: string;
}

interface LibraryRowProps {
  item: LibraryIndexItem;
  projects: Array<{ slug: string; name: string }>;
}

function LibraryRow({ item, projects }: LibraryRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [targetSlug, setTargetSlug] = useState(projects[0]?.slug ?? "");
  const [applyState, setApplyState] = useState<ApplyState>({ loading: false });

  async function handleApply(dryRun: boolean) {
    if (!targetSlug) return;
    setApplyState({ loading: true });
    try {
      const res = await fetch("/api/claude-config/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unit: { kind: item.kind, key: item.slug },
          source: { kind: "library", libraryId: item.id },
          target: { kind: "existing", slug: targetSlug },
          conflict: "skip",
          dryRun,
        }),
      });
      const data = await res.json() as { ok: boolean; status: string; error?: { message: string }; diffPreview?: string };
      if (!data.ok) {
        setApplyState({ loading: false, ok: false, message: data.error?.message ?? "Apply failed" });
      } else {
        setApplyState({
          loading: false,
          ok: true,
          message: dryRun
            ? `Would ${data.status} ${item.name}`
            : `${data.status.charAt(0).toUpperCase() + data.status.slice(1)} ${item.name}`,
        });
      }
    } catch (e) {
      setApplyState({ loading: false, ok: false, message: e instanceof Error ? e.message : "Network error" });
    }
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border-subtle)" }}>
      {/* Row header */}
      <div
        onClick={() => setExpanded((e) => !e)}
        style={{
          display: "flex", alignItems: "center", gap: "10px",
          padding: "10px 14px", cursor: "pointer",
          background: expanded ? "var(--bg-elevated)" : "transparent",
        }}
      >
        {expanded
          ? <ChevronDown style={{ width: 11, height: 11, color: "var(--text-muted)", flexShrink: 0 }} />
          : <ChevronRight style={{ width: 11, height: 11, color: "var(--text-muted)", flexShrink: 0 }} />
        }
        <KindChip kind={item.kind} />
        <span style={{
          fontSize: "0.8rem", fontFamily: "var(--font-body)",
          color: "var(--text-primary)", flex: 1, minWidth: 0,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {item.name}
        </span>
        <span style={{
          fontSize: "0.72rem", fontFamily: "var(--font-body)",
          color: "var(--text-secondary)", flexShrink: 0,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          maxWidth: "260px",
        }}>
          {item.description}
        </span>
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div style={{ padding: "12px 14px 14px 14px", background: "var(--bg-elevated)" }}>
          {/* Tags */}
          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginBottom: "12px" }}>
            {item.tags.map((t) => <TagChip key={t} tag={t} />)}
          </div>

          {/* Apply controls */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <label style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-body)" }}>
              Apply to
            </label>
            <select
              value={targetSlug}
              onChange={(e) => { setTargetSlug(e.target.value); setApplyState({ loading: false }); }}
              style={{
                fontSize: "0.72rem", fontFamily: "var(--font-body)",
                background: "var(--bg-surface)", color: "var(--text-primary)",
                border: "1px solid var(--border-subtle)", borderRadius: "4px",
                padding: "3px 6px", maxWidth: "180px",
              }}
            >
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>{p.name}</option>
              ))}
            </select>
            <button
              onClick={(e) => { e.stopPropagation(); void handleApply(true); }}
              disabled={applyState.loading || !targetSlug}
              style={{
                fontSize: "0.72rem", fontFamily: "var(--font-body)",
                color: "var(--text-secondary)",
                background: "var(--bg-surface)", border: "1px solid var(--border-subtle)",
                borderRadius: "4px", padding: "4px 10px", cursor: "pointer",
              }}
            >
              Preview
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); void handleApply(false); }}
              disabled={applyState.loading || !targetSlug}
              style={{
                fontSize: "0.72rem", fontFamily: "var(--font-body)",
                color: "var(--bg-surface)", background: "var(--accent)",
                border: "none", borderRadius: "4px", padding: "4px 10px", cursor: "pointer",
                opacity: applyState.loading || !targetSlug ? 0.5 : 1,
              }}
            >
              {applyState.loading ? "…" : "Apply"}
            </button>

            {applyState.message && (
              <span style={{
                fontSize: "0.72rem", fontFamily: "var(--font-body)",
                color: applyState.ok ? "#22c55e" : "#d45f45",
                display: "flex", alignItems: "center", gap: "4px",
              }}>
                {applyState.ok && <Check style={{ width: 11, height: 11 }} />}
                {applyState.message}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface ProjectEntry { slug: string; name: string; }

export function LibraryBrowser() {
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<string>("all");

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch("/api/library", { signal: controller.signal }).then((r) => r.json() as Promise<LibraryResponse>),
      fetch("/api/projects", { signal: controller.signal }).then((r) => r.json() as Promise<Array<{ slug: string; name: string }>>),
    ])
      .then(([lib, projs]) => {
        setData(lib);
        setProjects(projs.map((p) => ({ slug: p.slug, name: p.name ?? p.slug })));
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.toLowerCase();
    return data.items.filter((item) => {
      if (kindFilter !== "all" && item.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [data, query, kindFilter]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Header */}
      <header style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <BookOpen style={{ width: 14, height: 14, color: "var(--text-muted)" }} />
        <h1 style={{
          fontSize: "0.72rem", fontWeight: 600, letterSpacing: "0.08em",
          textTransform: "uppercase", color: "var(--text-secondary)",
          fontFamily: "var(--font-body)", margin: 0,
        }}>
          Library
        </h1>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
          curated commands, skills & agents · apply to any project
        </span>
      </header>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <div style={{
          flex: 1, display: "flex", alignItems: "center", gap: "6px",
          background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)", padding: "5px 10px",
        }}>
          <Search style={{ width: 12, height: 12, color: "var(--text-muted)", flexShrink: 0 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search library…"
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none",
              fontSize: "0.8rem", fontFamily: "var(--font-body)", color: "var(--text-primary)",
            }}
          />
        </div>
        {(["all", "command", "skill", "agent"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKindFilter(k)}
            style={{
              fontSize: "0.7rem", fontFamily: "var(--font-body)",
              padding: "4px 10px", borderRadius: "var(--radius)", cursor: "pointer",
              border: "1px solid var(--border-subtle)",
              background: kindFilter === k ? "var(--accent)" : "var(--bg-elevated)",
              color: kindFilter === k ? "var(--bg-surface)" : "var(--text-secondary)",
            }}
          >
            {k === "all" ? "All" : KIND_LABELS[k]}
          </button>
        ))}
        {data && (
          <span style={{ fontSize: "0.65rem", fontFamily: "var(--font-mono)", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
            {filtered.length}/{data.items.length}
          </span>
        )}
      </div>

      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} style={{ height: "42px", borderRadius: "var(--radius)", background: "var(--bg-elevated)", opacity: 0.5, animation: "pulse 1.5s ease-in-out infinite" }} />
          ))}
        </div>
      )}

      {!loading && (
        <div style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)", overflow: "hidden" }}>
          {filtered.length === 0 ? (
            <p style={{ padding: "16px", fontSize: "0.8rem", color: "var(--text-muted)", fontFamily: "var(--font-body)", margin: 0 }}>
              {query ? `No library items match "${query}".` : "No items in this category."}
            </p>
          ) : (
            filtered.map((item) => (
              <LibraryRow key={item.id} item={item} projects={projects} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
