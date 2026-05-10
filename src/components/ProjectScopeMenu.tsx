"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { ProjectGlyph } from "@/components/ui/design";
import { useScope } from "./ScopeProvider";
import { projectColor } from "@/lib/projectColor";
import type { ProjectData } from "@/lib/types";

interface ProjectScopeMenuProps {
  open: boolean;
  onClose: () => void;
  /** Pre-loaded project list. The caller is responsible for fetching; this
   *  component is purely presentational so it can be reused on any page. */
  projects: ProjectData[];
}

export function ProjectScopeMenu({ open, onClose, projects }: ProjectScopeMenuProps) {
  const { scope, setScope } = useScope();
  const [filter, setFilter] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogId = useId();
  // Capture whatever was focused before the modal opened so we can return
  // focus on close — required for a screen-reader-friendly modal.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Reset filter and focus input each open. On close, return focus to
  // whatever element opened the picker.
  useEffect(() => {
    if (!open) {
      previouslyFocusedRef.current?.focus();
      previouslyFocusedRef.current = null;
      return;
    }
    previouslyFocusedRef.current = (document.activeElement as HTMLElement) ?? null;
    setFilter("");
    setActiveIdx(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [filter, projects]);

  // Combined list: "All" first, then filtered projects.
  type ScopeItem =
    | { key: "all"; label: string; project?: undefined }
    | { key: string; label: string; project: ProjectData };
  const items = useMemo<ScopeItem[]>(
    () => [
      { key: "all", label: "All projects" },
      ...filtered.map((p) => ({ key: p.slug, label: p.name, project: p })),
    ],
    [filtered],
  );

  // ESC closes; Enter picks; arrows move
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const it = items[activeIdx];
        if (!it) return;
        setScope(it.key === "all" ? "all" : it.key);
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, items, activeIdx, onClose, setScope]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 120,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: "calc(100vw - 32px)",
          background: "var(--bg-elev)",
          border: "1px solid var(--line)",
          borderRadius: 14,
          boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}
      >
        <h2
          id={`${dialogId}-title`}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: "hidden",
            clip: "rect(0,0,0,0)",
            whiteSpace: "nowrap",
            border: 0,
          }}
        >
          Switch project scope
        </h2>
        <div
          style={{
            padding: 14,
            borderBottom: "1px solid var(--line-soft)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ color: "var(--text-3)", display: "inline-flex" }}>
            <Search width={16} height={16} />
          </span>
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setActiveIdx(0);
            }}
            placeholder="Filter projects…"
            style={{
              background: "transparent",
              border: 0,
              outline: 0,
              color: "var(--text)",
              flex: 1,
              fontSize: 14,
              fontFamily: "inherit",
            }}
          />
          <span className="kbd">esc</span>
        </div>

        <div
          role="listbox"
          aria-label="Projects"
          aria-activedescendant={items[activeIdx] ? `${dialogId}-opt-${items[activeIdx].key}` : undefined}
          style={{ maxHeight: 400, overflowY: "auto", padding: 6 }}
        >
          {items.map((it, idx) => {
            const isActive = idx === activeIdx;
            const isCurrent = scope === (it.key === "all" ? "all" : it.key);
            return (
              <button
                key={it.key}
                type="button"
                id={`${dialogId}-opt-${it.key}`}
                role="option"
                aria-selected={isCurrent}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => {
                  setScope(it.key === "all" ? "all" : it.key);
                  onClose();
                }}
                className={"nav-item" + (isActive ? " active" : "")}
                style={{
                  margin: 2,
                  cursor: "pointer",
                  width: "calc(100% - 4px)",
                  background: "transparent",
                  border: 0,
                  textAlign: "left",
                  font: "inherit",
                  color: "inherit",
                }}
              >
                {it.key === "all" ? (
                  <span
                    className="ico"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 18,
                      height: 18,
                      fontWeight: 700,
                      fontSize: 14,
                      color: "var(--text-2)",
                    }}
                  >
                    ∞
                  </span>
                ) : (
                  <ProjectGlyph name={it.label} color={projectColor(it.key)} size={18} />
                )}
                <span
                  className="label"
                  style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {it.label}
                </span>
                {it.key !== "all" && it.project && (
                  <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>
                    {projectMetricLabel(it.project)}
                  </span>
                )}
                {isCurrent && (
                  <span style={{ marginLeft: 8, color: "var(--accent)", fontSize: 12 }}>✓</span>
                )}
              </button>
            );
          })}
          {items.length <= 1 && filter && (
            <div style={{ padding: "16px 12px", textAlign: "center", color: "var(--text-3)", fontSize: 12 }}>
              No projects match &ldquo;{filter}&rdquo;
            </div>
          )}
        </div>

        <div
          style={{
            padding: "10px 14px",
            borderTop: "1px solid var(--line-soft)",
            fontSize: 11,
            color: "var(--text-3)",
            display: "flex",
            gap: 14,
          }}
        >
          <span>
            <span className="kbd">↑↓</span> navigate
          </span>
          <span>
            <span className="kbd">↵</span> scope
          </span>
          <span style={{ marginLeft: "auto" }}>
            <span className="kbd">esc</span> close
          </span>
        </div>
      </div>
    </div>
  );
}

function projectMetricLabel(p: ProjectData): string {
  // Compact, mono-friendly summary. Prefer the live "running" signal from
  // recent Claude session metadata; otherwise show uncommitted file count
  // from `git status` so users get a sense of "is this dirty?" at a glance.
  if (p.claude?.mostRecentSessionStatus === "working") return "● live";
  if (p.git?.isDirty && p.git.uncommittedCount > 0) {
    return `+${p.git.uncommittedCount}`;
  }
  return "—";
}
