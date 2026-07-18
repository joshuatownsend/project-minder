"use client";

import { useEffect, useRef, useState } from "react";
import { FolderX, X } from "lucide-react";
import type { SkippedRoot } from "@/lib/types";

const DISMISS_KEY = "skipped-roots-dismissed-at";

const REASON_TEXT: Record<SkippedRoot["reason"], string> = {
  "wsl-stopped": "WSL distro is stopped — start it and rescan (Minder never wakes a stopped VM)",
  "wsl-distro-not-found": "WSL distro not found — check the distro name in the path",
  "wsl-unavailable": "WSL is not available on this machine",
  unreadable: "Directory doesn't exist or isn't readable",
};

/**
 * Topbar indicator (sibling of PortConflictIndicator, same interaction
 * pattern) shown when the last scan skipped one or more configured roots —
 * e.g. a \\wsl.localhost root whose distro is stopped. Without this the
 * projects under that root silently vanish from the dashboard.
 */
export function SkippedRootsIndicator() {
  const [skipped, setSkipped]     = useState<SkippedRoot[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen]           = useState(false);
  const containerRef              = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dismissedAt = sessionStorage.getItem(DISMISS_KEY);
    if (dismissedAt) setDismissed(true);

    async function fetchSkipped() {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok) return;
        const data = await res.json();
        setSkipped(data.skippedRoots ?? []);
      } catch {
        // ignore
      }
    }
    fetchSkipped();
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

  if (skipped.length === 0 || dismissed) return null;

  function dismiss() {
    sessionStorage.setItem(DISMISS_KEY, new Date().toISOString());
    setDismissed(true);
    setOpen(false);
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={`${skipped.length} scan root${skipped.length !== 1 ? "s" : ""} skipped`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          padding: "4px 7px",
          borderRadius: "var(--radius)",
          background: open ? "var(--info-bg)" : "transparent",
          border: "1px solid",
          borderColor: open ? "var(--border-default)" : "transparent",
          color: "var(--info)",
          cursor: "pointer",
          transition: "background 0.12s, border-color 0.12s",
        }}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <FolderX style={{ width: "13px", height: "13px" }} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            fontWeight: 600,
            lineHeight: 1,
          }}
        >
          {skipped.length}
        </span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 50,
            width: "300px",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius)",
            boxShadow: "0 8px 24px oklch(0 0 0 / 0.4)",
            overflow: "hidden",
          }}
          role="dialog"
          aria-label="Skipped scan roots"
        >
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
                color: "var(--info)",
              }}
            >
              <FolderX style={{ width: "12px", height: "12px" }} />
              Skipped Scan Roots
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

          <ul style={{ margin: 0, padding: "8px 0", listStyle: "none" }}>
            {skipped.map((s) => (
              <li
                key={s.root}
                style={{
                  padding: "6px 12px",
                  fontSize: "0.72rem",
                  lineHeight: 1.5,
                  color: "var(--text-secondary)",
                  borderBottom: "1px solid var(--border-subtle)",
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.7rem",
                    color: "var(--text-primary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={s.root}
                >
                  {s.root}
                </div>
                <div style={{ marginTop: "2px", color: "var(--text-muted)" }}>
                  {REASON_TEXT[s.reason] ?? s.reason}
                </div>
              </li>
            ))}
          </ul>

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
              Dismiss for this session
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
