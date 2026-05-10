"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Search } from "lucide-react";
import {
  buildCommandIndex,
  filterCommands,
  getRecentIds,
  recordRecent,
  type CommandItem,
} from "@/lib/commandPalette";
import { usePulse } from "./PulseProvider";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (href: string) => void;
  onAction: (action: string) => void;
}

const INDEX_TTL_MS = 5_000;
let cachedIndex: CommandItem[] | null = null;
let cachedAt = 0;

export function CommandPalette({ open, onClose, onNavigate, onAction }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CommandItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { snapshot } = usePulse();

  const badgeCounts: Record<string, number> = {
    approvals: snapshot.approvalCount,
    steps: snapshot.pendingSteps,
    inbox: snapshot.inboxCount,
    decisions: snapshot.decisionCount,
  };

  // Load index on open
  useEffect(() => {
    if (!open) { setQuery(""); setSelectedIdx(0); return; }
    const now = Date.now();
    if (cachedIndex && now - cachedAt < INDEX_TTL_MS) {
      setItems(cachedIndex);
      return;
    }
    setLoading(true);
    buildCommandIndex().then((idx) => {
      cachedIndex = idx;
      cachedAt = Date.now();
      setItems(idx);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [open]);

  // Focus input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Scroll-lock
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const recentIds = open ? getRecentIds() : [];

  const displayed = (() => {
    if (query) return filterCommands(items, query);
    // Empty query: recents first, then all nav items
    const recentSet = new Set(recentIds);
    const recentItems = recentIds
      .map((id) => items.find((i) => i.id === id))
      .filter((i): i is CommandItem => i !== undefined);
    const rest = items.filter((i) => !recentSet.has(i.id) && !i.category);
    return [...recentItems, ...rest];
  })();

  // Reset selection when displayed list changes
  useEffect(() => { setSelectedIdx(0); }, [query, displayed.length]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.querySelector<HTMLElement>("[aria-selected='true']");
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const select = useCallback((item: CommandItem) => {
    recordRecent(item.id);
    if (item.href) {
      onNavigate(item.href);
    } else if (item.action) {
      onAction(item.action);
    }
    onClose();
  }, [onNavigate, onAction, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, displayed.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && displayed[selectedIdx]) {
      e.preventDefault();
      select(displayed[selectedIdx]);
    }
  }, [displayed, selectedIdx, select, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="relative z-10 w-full max-w-xl mx-4 rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-2xl flex flex-col overflow-hidden"
        style={{ maxHeight: "70vh" }}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <Search style={{ width: 14, height: 14, color: "var(--text-muted)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={displayed.length > 0}
            aria-controls="palette-listbox"
            aria-activedescendant={displayed[selectedIdx] ? `palette-opt-${selectedIdx}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Go to page, project, or session…"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--text-primary)",
              fontSize: "0.9rem",
              fontFamily: "var(--font-body)",
            }}
          />
          {loading && (
            <span style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>Loading…</span>
          )}
        </div>

        {/* Results */}
        <ul
          ref={listRef}
          id="palette-listbox"
          role="listbox"
          aria-label="Results"
          style={{ overflowY: "auto", flex: 1, margin: 0, padding: "4px 0", listStyle: "none" }}
        >
          {displayed.length === 0 && !loading && (
            <li style={{
              padding: "16px",
              textAlign: "center",
              fontSize: "0.78rem",
              color: "var(--text-muted)",
            }}>
              No results
            </li>
          )}
          {displayed.map((item, idx) => {
            const isSelected = idx === selectedIdx;
            const badge = item.badgeKey ? badgeCounts[item.badgeKey] : 0;
            return (
              <li
                key={item.id}
                id={`palette-opt-${idx}`}
                role="option"
                aria-selected={isSelected}
                onClick={() => select(item)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                  padding: "7px 12px",
                  cursor: "pointer",
                  background: isSelected ? "var(--info-bg)" : "transparent",
                  color: isSelected ? "var(--info)" : "var(--text-primary)",
                }}
              >
                <span style={{ display: "flex", flexDirection: "column", gap: "1px", minWidth: 0 }}>
                  <span style={{ fontSize: "0.82rem", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.label}
                  </span>
                  {item.sublabel && (
                    <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.sublabel}
                    </span>
                  )}
                </span>
                {badge > 0 && (
                  <span style={{
                    fontSize: "0.65rem",
                    fontFamily: "var(--font-mono)",
                    background: "var(--info-bg)",
                    color: "var(--info)",
                    borderRadius: "10px",
                    padding: "1px 6px",
                    flexShrink: 0,
                  }}>
                    {badge}
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        {/* Footer hint */}
        <div style={{
          padding: "6px 12px",
          borderTop: "1px solid var(--border-subtle)",
          display: "flex",
          gap: "12px",
          fontSize: "0.65rem",
          color: "var(--text-muted)",
        }}>
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>
  );
}
