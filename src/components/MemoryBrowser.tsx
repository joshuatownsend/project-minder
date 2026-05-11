"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import type { MemoryFileEntry, MemoryIndexSummary, MemoryScope } from "@/lib/types";
import { MemoryEditor } from "./MemoryEditor";

const SCOPE_LABEL: Record<MemoryScope, string> = {
  user: "User",
  project: "Project CLAUDE.md",
  auto: "Auto-memory",
};

const SCOPE_ORDER: MemoryScope[] = ["user", "project", "auto"];

type ScopeFilter = MemoryScope | "all";

export function MemoryBrowser() {
  const [entries, setEntries] = useState<MemoryFileEntry[] | null>(null);
  const [indexSummaries, setIndexSummaries] = useState<MemoryIndexSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [showStaleOnly, setShowStaleOnly] = useState(false);

  async function reload(signal?: AbortSignal) {
    try {
      const r = await fetch("/api/memory", { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as {
        entries: MemoryFileEntry[];
        indexSummaries?: MemoryIndexSummary[];
      };
      setEntries(json.entries);
      setIndexSummaries(json.indexSummaries ?? []);
      setError(null);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Failed to load memory files");
    }
  }

  useEffect(() => {
    const ctrl = new AbortController();
    reload(ctrl.signal);
    return () => ctrl.abort();
  }, []);

  const filtered = useMemo(() => {
    if (!entries) return [];
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (scopeFilter !== "all" && e.scope !== scopeFilter) return false;
      if (showStaleOnly && !isStale(e)) return false;
      if (!q) return true;
      return (
        e.displayName.toLowerCase().includes(q) ||
        e.preview.toLowerCase().includes(q) ||
        (e.projectSlug ?? "").toLowerCase().includes(q) ||
        (e.projectName ?? "").toLowerCase().includes(q)
      );
    });
  }, [entries, search, scopeFilter, showStaleOnly]);

  const grouped = useMemo(() => {
    const out: Record<MemoryScope, MemoryFileEntry[]> = { user: [], project: [], auto: [] };
    for (const e of filtered) out[e.scope].push(e);
    return out;
  }, [filtered]);

  const { scopeCounts, staleCount } = useMemo(() => {
    const counts: Record<MemoryScope, number> = { user: 0, project: 0, auto: 0 };
    let stale = 0;
    if (entries) {
      for (const e of entries) {
        counts[e.scope]++;
        if (isStale(e)) stale++;
      }
    }
    return { scopeCounts: counts, staleCount: stale };
  }, [entries]);

  const indexRollup = useMemo(() => {
    let projects = 0;
    let entryCount = 0;
    let lineCount = 0;
    let orphans = 0;
    let dangling = 0;
    let maxLineCount = 0;
    for (const s of indexSummaries) {
      projects++;
      entryCount += s.entryCount;
      lineCount += s.lineCount;
      orphans += s.orphans.length;
      dangling += s.dangling.length;
      if (s.lineCount > maxLineCount) maxLineCount = s.lineCount;
    }
    return { projects, entryCount, lineCount, orphans, dangling, maxLineCount };
  }, [indexSummaries]);

  const selected = entries?.find((e) => e.id === selectedId) ?? null;

  if (error) {
    return <p style={{ padding: "40px 0", color: "var(--status-error-text, var(--accent))" }}>{error}</p>;
  }
  if (!entries) {
    return <p style={{ padding: "40px 0", color: "var(--text-muted)" }}>Loading</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {indexRollup.projects > 0 && <IndexBanner rollup={indexRollup} />}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search memory files…"
          style={{
            flex: "1 1 240px",
            padding: "8px 12px",
            fontSize: "0.78rem",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius)",
            color: "var(--text-primary)",
          }}
        />
        <ScopeChip
          label={`All (${entries.length})`}
          active={scopeFilter === "all"}
          onClick={() => setScopeFilter("all")}
        />
        {SCOPE_ORDER.map((s) => (
          <ScopeChip
            key={s}
            label={`${SCOPE_LABEL[s]} (${scopeCounts[s]})`}
            active={scopeFilter === s}
            onClick={() => setScopeFilter(s)}
          />
        ))}
        <ScopeChip
          label={`Stale (${staleCount})`}
          active={showStaleOnly}
          onClick={() => setShowStaleOnly((v) => !v)}
          variant="warn"
        />
      </div>

      <div style={{ display: "flex", gap: "16px", alignItems: "flex-start" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            width: "320px",
            flexShrink: 0,
          }}
        >
          {SCOPE_ORDER.map((scope) => {
            const list = grouped[scope];
            if (list.length === 0) return null;
            return (
              <div key={scope} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <SectionHeader label={`${SCOPE_LABEL[scope]} · ${list.length}`} />
                {list.map((entry) => (
                  <MemoryRow
                    key={entry.id}
                    entry={entry}
                    active={selectedId === entry.id}
                    onClick={() => setSelectedId(entry.id)}
                  />
                ))}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <p style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>No matches.</p>
          )}
        </div>
        {selected ? (
          <MemoryEditor entry={selected} onSaved={reload} />
        ) : (
          <div
            style={{
              flex: 1,
              padding: "60px 20px",
              textAlign: "center",
              border: "1px dashed var(--border-subtle)",
              borderRadius: "var(--radius)",
              color: "var(--text-muted)",
              fontSize: "0.78rem",
            }}
          >
            Select a memory file on the left to view or edit it.
          </div>
        )}
      </div>
    </div>
  );
}

// Article principle 3 + 4: surface the always-loaded index size and the cost
// of bad bookkeeping (orphans / dangling links) in a single glance so the user
// can see whether MEMORY.md is healthy without opening every file.
function IndexBanner({
  rollup,
}: {
  rollup: {
    projects: number;
    entryCount: number;
    lineCount: number;
    orphans: number;
    dangling: number;
    maxLineCount: number;
  };
}) {
  const cap = 200;
  const capPct = rollup.maxLineCount / cap;
  // 80% amber, 95% red per the locked Phase 1 budget thresholds.
  const tone: "ok" | "warn" | "alarm" =
    capPct >= 0.95 ? "alarm" : capPct >= 0.8 ? "warn" : "ok";
  const toneColor =
    tone === "alarm" ? "var(--accent)" : tone === "warn" ? "var(--accent)" : "var(--text-muted)";
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "14px",
        padding: "10px 14px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        fontSize: "0.72rem",
        fontFamily: "var(--font-body)",
        color: "var(--text-secondary)",
      }}
    >
      <span style={{ color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        MEMORY.md index
      </span>
      <span>
        {rollup.projects} {rollup.projects === 1 ? "project" : "projects"}
      </span>
      <span>{rollup.entryCount} entries</span>
      <span style={{ color: toneColor }}>
        max {rollup.maxLineCount}/{cap} lines
      </span>
      {rollup.orphans > 0 && (
        <span style={{ color: "var(--accent)" }}>{rollup.orphans} orphan{rollup.orphans === 1 ? "" : "s"}</span>
      )}
      {rollup.dangling > 0 && (
        <span style={{ color: "var(--accent)" }}>
          {rollup.dangling} dangling link{rollup.dangling === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

function ScopeChip({
  label,
  active,
  onClick,
  variant,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  variant?: "warn";
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 12px",
        fontSize: "0.7rem",
        fontFamily: "var(--font-body)",
        background: active ? "var(--accent-bg)" : "var(--bg-surface)",
        color: active ? "var(--accent)" : variant === "warn" ? "var(--accent)" : "var(--text-secondary)",
        border: `1px solid ${active ? "var(--accent-border)" : "var(--border-subtle)"}`,
        borderRadius: "var(--radius)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <span
        style={{
          fontSize: "0.6rem",
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
          fontFamily: "var(--font-body)",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
    </div>
  );
}

function MemoryRow({
  entry,
  active,
  onClick,
}: {
  entry: MemoryFileEntry;
  active: boolean;
  onClick: () => void;
}) {
  const stale = isStale(entry);
  const rel = formatDistanceToNow(new Date(entry.mtimeMs), { addSuffix: true });
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        padding: "10px 12px",
        textAlign: "left",
        background: active ? "var(--accent-bg)" : "var(--bg-elevated)",
        border: `1px solid ${active ? "var(--accent-border)" : "var(--border-subtle)"}`,
        borderRadius: "var(--radius)",
        cursor: "pointer",
        transition: "background 0.1s, border-color 0.1s",
        width: "100%",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <span
          style={{
            fontSize: "0.78rem",
            fontFamily: "var(--font-mono)",
            color: active ? "var(--accent)" : "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
        >
          {entry.displayName}
        </span>
        {stale && <StaleChip entry={entry} />}
      </div>
      {entry.projectName && (
        <span
          style={{
            fontSize: "0.66rem",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.projectName}
        </span>
      )}
      {entry.preview && (
        <span
          style={{
            fontSize: "0.68rem",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-body)",
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {entry.preview}
        </span>
      )}
      <span
        style={{
          fontSize: "0.62rem",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {rel} · {(entry.sizeBytes / 1024).toFixed(1)} KB
      </span>
    </button>
  );
}

function StaleChip({ entry }: { entry: MemoryFileEntry }) {
  const reasons: string[] = [];
  if (entry.stale.ageOver30d) reasons.push("age > 30d");
  if (entry.stale.brokenImports.length > 0) {
    reasons.push(`${entry.stale.brokenImports.length} broken @import`);
  }
  return (
    <span
      title={reasons.join(" · ")}
      style={{
        marginLeft: "auto",
        fontSize: "0.58rem",
        fontFamily: "var(--font-mono)",
        color: "var(--accent)",
        background: "var(--accent-bg)",
        border: "1px solid var(--accent-border)",
        borderRadius: "3px",
        padding: "1px 5px",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      stale
    </span>
  );
}

function isStale(entry: MemoryFileEntry): boolean {
  return entry.stale.ageOver30d || entry.stale.brokenImports.length > 0;
}
