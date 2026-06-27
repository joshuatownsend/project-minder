"use client";

import { useState, useCallback } from "react";
import { ChevronRight, ChevronDown, Archive, Loader2, CheckCircle2 } from "lucide-react";
import { TodoInfo, ManualStepsInfo } from "@/lib/types";

type ArchivedKind = "todos" | "manual-steps";

/**
 * Read-only disclosure that lazy-loads archived items from the companion
 * *.archive.md files. The scan orchestrator ignores those files (so active
 * counts stay clean), so this fetches on demand the first time it's expanded.
 */
export function ArchivedDisclosure({ kind, slug }: { kind: ArchivedKind; slug: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [todos, setTodos] = useState<TodoInfo | null>(null);
  const [manual, setManual] = useState<ManualStepsInfo | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url =
        kind === "todos"
          ? `/api/projects/${slug}/todos/archive`
          : `/api/manual-steps/${slug}?archived=1`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (kind === "todos") setTodos(data as TodoInfo);
        else setManual(data as ManualStepsInfo);
      }
    } catch {
      // leave empty — the render falls back to "No archived items."
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  }, [kind, slug]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !loading) void load();
  };

  const count = kind === "todos" ? todos?.total ?? 0 : manual?.totalSteps ?? 0;

  return (
    <div
      style={{
        marginTop: "14px",
        borderTop: "1px solid var(--border-subtle)",
        paddingTop: "10px",
      }}
    >
      <button
        onClick={toggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          background: "transparent",
          border: "none",
          padding: "2px 0",
          cursor: "pointer",
          color: "var(--text-muted)",
          fontSize: "0.7rem",
          fontFamily: "var(--font-body)",
          letterSpacing: "0.02em",
        }}
        title="Completed/obsolete items moved out of the active list"
      >
        {open ? (
          <ChevronDown style={{ width: "11px", height: "11px" }} />
        ) : (
          <ChevronRight style={{ width: "11px", height: "11px" }} />
        )}
        <Archive style={{ width: "11px", height: "11px" }} />
        <span>Archived{loaded && count > 0 ? ` (${count})` : ""}</span>
        {loading && (
          <Loader2 style={{ width: "10px", height: "10px", animation: "spin 1s linear infinite" }} />
        )}
      </button>

      {open && loaded && (
        <div style={{ marginTop: "8px", paddingLeft: "4px" }}>
          {count === 0 ? (
            <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", padding: "4px 0" }}>
              No archived items.
            </p>
          ) : kind === "todos" ? (
            <ul style={{ display: "flex", flexDirection: "column", gap: "2px", padding: 0, margin: 0, listStyle: "none" }}>
              {todos!.items.map((item, i) => (
                <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: "8px", padding: "3px 0" }}>
                  <CheckCircle2
                    style={{ width: "13px", height: "13px", color: "var(--text-muted)", flexShrink: 0, marginTop: "1px" }}
                  />
                  <span
                    style={{
                      fontSize: "0.8rem",
                      color: "var(--text-muted)",
                      textDecoration: item.completed ? "line-through" : "none",
                      lineHeight: 1.5,
                    }}
                  >
                    {item.text}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {manual!.entries.map((entry, i) => (
                <div key={`${entry.featureSlug}-${i}`}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px", flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.64rem", color: "var(--text-muted)" }}>
                      {entry.date}
                    </span>
                    {entry.featureSlug && (
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "0.64rem",
                          color: "var(--text-secondary)",
                          background: "var(--bg-elevated)",
                          border: "1px solid var(--border-subtle)",
                          borderRadius: "3px",
                          padding: "1px 4px",
                        }}
                      >
                        {entry.featureSlug}
                      </span>
                    )}
                    <span style={{ fontSize: "0.74rem", fontWeight: 500, color: "var(--text-secondary)" }}>
                      {entry.title}
                    </span>
                  </div>
                  <div style={{ paddingLeft: "4px", display: "flex", flexDirection: "column", gap: "1px" }}>
                    {entry.steps.map((step, j) => (
                      <div key={j} style={{ display: "flex", alignItems: "flex-start", gap: "7px", padding: "1px 0" }}>
                        <CheckCircle2
                          style={{ width: "12px", height: "12px", color: "var(--text-muted)", flexShrink: 0, marginTop: "2px" }}
                        />
                        <span
                          style={{
                            fontSize: "0.76rem",
                            lineHeight: 1.4,
                            color: "var(--text-muted)",
                            textDecoration: step.completed ? "line-through" : "none",
                          }}
                        >
                          {step.text}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
