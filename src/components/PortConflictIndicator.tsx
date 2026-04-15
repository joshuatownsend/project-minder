"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { PortConflict } from "@/lib/types";

const DISMISS_KEY = "port-conflicts-dismissed-at";

export function PortConflictIndicator() {
  const [conflicts, setConflicts]   = useState<PortConflict[]>([]);
  const [dismissed, setDismissed]   = useState(false);
  const [open, setOpen]             = useState(false);
  const containerRef                = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Restore dismiss state across navigations (session-scoped)
    const dismissedAt = sessionStorage.getItem(DISMISS_KEY);
    if (dismissedAt) setDismissed(true);

    async function fetchConflicts() {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok) return;
        const data = await res.json();
        setConflicts(data.portConflicts ?? []);
      } catch {
        // ignore
      }
    }
    fetchConflicts();
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  if (conflicts.length === 0 || dismissed) return null;

  function dismiss() {
    sessionStorage.setItem(DISMISS_KEY, new Date().toISOString());
    setDismissed(true);
    setOpen(false);
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {/* Trigger icon */}
      <button
        onClick={() => setOpen((v) => !v)}
        title={`${conflicts.length} port conflict${conflicts.length !== 1 ? "s" : ""}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          padding: "4px 7px",
          borderRadius: "var(--radius)",
          background: open ? "var(--accent-bg)" : "transparent",
          border: "1px solid",
          borderColor: open ? "var(--accent-border)" : "transparent",
          color: "var(--accent)",
          cursor: "pointer",
          transition: "background 0.12s, border-color 0.12s",
        }}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <AlertTriangle style={{ width: "13px", height: "13px" }} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            fontWeight: 600,
            lineHeight: 1,
          }}
        >
          {conflicts.length}
        </span>
      </button>

      {/* Popover */}
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 50,
            width: "280px",
            background: "var(--bg-elevated)",
            border: "1px solid var(--accent-border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 8px 24px oklch(0 0 0 / 0.4)",
            overflow: "hidden",
          }}
          role="dialog"
          aria-label="Port conflicts"
        >
          {/* Popover header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 12px 8px",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "0.72rem",
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "var(--accent)",
              }}
            >
              <AlertTriangle style={{ width: "12px", height: "12px" }} />
              Port Conflicts
            </div>
            <button
              onClick={() => setOpen(false)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: "20px", height: "20px",
                background: "transparent", border: "none",
                color: "var(--text-muted)", cursor: "pointer", borderRadius: "3px",
              }}
              aria-label="Close"
            >
              <X style={{ width: "12px", height: "12px" }} />
            </button>
          </div>

          {/* Conflict list */}
          <ul style={{ margin: 0, padding: "8px 0", listStyle: "none" }}>
            {conflicts.map((c) => (
              <li
                key={c.port}
                style={{
                  padding: "6px 12px",
                  fontSize: "0.78rem",
                  lineHeight: 1.5,
                  color: "var(--text-secondary)",
                  borderBottom: "1px solid var(--border-subtle)",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontWeight: 600,
                    color: "var(--accent)",
                    marginRight: "4px",
                  }}
                >
                  :{c.port}
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>
                  {c.type}
                </span>
                <div
                  style={{
                    marginTop: "2px",
                    fontSize: "0.72rem",
                    color: "var(--text-secondary)",
                  }}
                >
                  {c.projects.join(", ")}
                </div>
              </li>
            ))}
          </ul>

          {/* Footer */}
          <div style={{ padding: "8px 12px" }}>
            <button
              onClick={dismiss}
              style={{
                width: "100%",
                padding: "6px",
                fontSize: "0.72rem",
                fontFamily: "var(--font-body)",
                letterSpacing: "0.02em",
                color: "var(--text-muted)",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius)",
                cursor: "pointer",
                transition: "color 0.12s, border-color 0.12s",
              }}
            >
              Dismiss until next scan
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
