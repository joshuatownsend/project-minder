"use client";

import { useEffect, useMemo, useState } from "react";
import { Workflow as WorkflowIcon, Search, ChevronDown, ChevronRight } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";
import type { ClaudeWorkflowEntry } from "@/lib/indexer/walkWorkflows";

/**
 * C1 — the Claude Code workflow catalog.
 *
 * One row per workflow, not per run: the Workflow tool persists a script per
 * session, so a workflow used weekly has dozens of near-identical copies on
 * disk. Folding them is what turns a directory listing into an answer to "which
 * workflows do I actually use, and how often".
 */

// The list route strips `scriptExcerpt` and `runs`; the detail route has both.
type WorkflowRow = Omit<ClaudeWorkflowEntry, "scriptExcerpt" | "runs"> & {
  scriptExcerpt?: string;
  runs?: ClaudeWorkflowEntry["runs"];
};

type SortKey = "recent" | "runs" | "name";

export function WorkflowsBrowser() {
  const [rows, setRows] = useState<WorkflowRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [expanded, setExpanded] = useState<string | null>(null);
  // An emptiness test is not a pending test: a failed request leaves the
  // state empty forever, so a marker driven by it never clears and every
  // `[data-loading]` consumer reads the page as busy indefinitely
  // (Codex, PR #517).
  const [pending, setPending] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/workflows")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body) => {
        if (cancelled) return;
        // The catalog routes return the bare array — a client reading
        // `body.data` gets undefined here (see the route comment).
        setRows(Array.isArray(body) ? body : []);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setPending(false));
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.toLowerCase().trim();
    const filtered = q
      ? rows.filter((r) =>
          [r.name, r.description, r.whenToUse]
            .filter(Boolean)
            .some((f) => (f as string).toLowerCase().includes(q))
        )
      : rows;
    const sorted = [...filtered];
    if (sort === "runs") sorted.sort((a, b) => b.runCount - a.runCount);
    else if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else
      sorted.sort((a, b) => {
        // A workflow whose runs carried no timestamp sorts last rather than
        // being treated as epoch-zero and jumping to the bottom of "recent"
        // looking like a stale entry.
        if (a.lastRunAt && b.lastRunAt) return b.lastRunAt.localeCompare(a.lastRunAt);
        if (a.lastRunAt) return -1;
        if (b.lastRunAt) return 1;
        return a.name.localeCompare(b.name);
      });
    return sorted;
  }, [rows, query, sort]);

  if (error) {
    return <p style={{ color: "var(--status-error-text)" }}>Could not load workflows: {error}</p>;
  }

  return (
    <div>
      <header style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px", flexWrap: "wrap" }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "1.1rem", margin: 0 }}>
          <WorkflowIcon aria-hidden="true" style={{ width: "16px", height: "16px" }} />
          Workflows
        </h1>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto" }}>
          <Search aria-hidden="true" style={{ width: "13px", height: "13px", color: "var(--text-muted)" }} />
          <span className="sr-only">Search workflows</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            style={{
              background: "var(--bg-surface)", border: "1px solid var(--border-subtle)",
              borderRadius: "4px", padding: "3px 8px", fontSize: "0.78rem", color: "var(--text-primary)",
            }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span className="sr-only">Sort workflows by</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            style={{
              background: "var(--bg-surface)", border: "1px solid var(--border-subtle)",
              borderRadius: "4px", padding: "3px 8px", fontSize: "0.78rem", color: "var(--text-primary)",
            }}
          >
            <option value="recent">Most recent</option>
            <option value="runs">Most runs</option>
            <option value="name">Name A–Z</option>
          </select>
        </label>
      </header>

      {pending && <p data-loading="true" style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>Loading…</p>}

      {rows !== null && rows.length === 0 && (
        <p style={{ color: "var(--text-muted)", fontSize: "0.82rem", lineHeight: 1.6 }}>
          No workflows recorded yet. Claude Code writes one here each time the{" "}
          <code>Workflow</code> tool runs — these are multi-agent orchestration
          scripts, not the GitHub Actions workflows shown on a project&apos;s CI/CD panel.
        </p>
      )}

      {visible.map((row) => {
        const open = expanded === row.id;
        return (
          <div
            key={row.id}
            style={{
              border: "1px solid var(--border-subtle)", borderRadius: "6px",
              padding: "10px 12px", marginBottom: "8px", background: "var(--bg-surface)",
            }}
          >
            <button
              onClick={() => setExpanded(open ? null : row.id)}
              aria-expanded={open}
              style={{
                display: "flex", alignItems: "center", gap: "8px", width: "100%",
                background: "none", border: "none", padding: 0, cursor: "pointer",
                color: "var(--text-primary)", textAlign: "left",
              }}
            >
              {open
                ? <ChevronDown aria-hidden="true" style={{ width: "13px", height: "13px" }} />
                : <ChevronRight aria-hidden="true" style={{ width: "13px", height: "13px" }} />}
              <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{row.name}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-muted)" }}>
                {row.runCount} {row.runCount === 1 ? "run" : "runs"}
              </span>
              {row.lastRunAt && (
                <span style={{ fontSize: "0.68rem", color: "var(--text-muted)" }}>
                  last {formatRelativeTime(row.lastRunAt)}
                </span>
              )}
              {row.parseWarnings && row.parseWarnings.length > 0 && (
                <span
                  title={row.parseWarnings.join("; ")}
                  style={{ fontSize: "0.68rem", color: "var(--accent)" }}
                >
                  <span className="sr-only">
                    Could not fully read this workflow&apos;s meta block: {row.parseWarnings.join("; ")}
                  </span>
                  <span aria-hidden="true">!</span>
                </span>
              )}
            </button>

            {row.description && (
              <p style={{ margin: "6px 0 0 21px", fontSize: "0.78rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                {row.description}
              </p>
            )}

            {open && (
              <div style={{ margin: "10px 0 0 21px", fontSize: "0.76rem", color: "var(--text-secondary)" }}>
                {row.whenToUse && (
                  <p style={{ marginTop: 0 }}>
                    <strong style={{ color: "var(--text-primary)" }}>When to use: </strong>
                    {row.whenToUse}
                  </p>
                )}
                {row.phases && row.phases.length > 0 && (
                  <div>
                    <strong style={{ color: "var(--text-primary)" }}>Phases</strong>
                    <ol style={{ margin: "4px 0 0", paddingLeft: "18px", lineHeight: 1.6 }}>
                      {row.phases.map((p, i) => (
                        <li key={`${p.title}-${i}`}>
                          {p.title}
                          {p.detail && <span style={{ color: "var(--text-muted)" }}> — {p.detail}</span>}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                <p style={{ marginBottom: 0, color: "var(--text-muted)" }}>
                  Ran in {row.projectDirNames.length}{" "}
                  {row.projectDirNames.length === 1 ? "project" : "projects"}
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
