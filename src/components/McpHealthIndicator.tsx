"use client";

import { useEffect, useRef, useState } from "react";
import type { McpHealth } from "@/lib/types";
import { useHelp } from "./HelpProvider";

/**
 * MCP integrations health strip (ported from agentic-os-dashboard). A compact
 * row of dots — one per configured MCP server — that opens a click-through
 * popover listing each server with its transport, source, and probe detail.
 * Self-gating: renders nothing when the `mcpHealth` flag is off (the route
 * returns `enabled: false`) or before the first probe results land, so there's
 * no empty-state flash in the top bar.
 *
 * Polls faster (2s) while probes are in flight, then settles to 15s.
 */

interface McpHealthResponse {
  enabled: boolean;
  servers: Record<string, McpHealth>;
  pending: number;
  total: number;
}

type Status = McpHealth["status"];

const DOT_COLOR: Record<Status, string> = {
  up: "var(--ok, #3fb950)",
  down: "var(--danger, #f85149)",
  unknown: "var(--text-3, #7d8590)",
};

const STATUS_LABEL: Record<Status, string> = {
  up: "up",
  down: "down",
  unknown: "unknown",
};

// Problems first, then unknown, then healthy — and alphabetical within each.
const STATUS_ORDER: Record<Status, number> = { down: 0, unknown: 1, up: 2 };

export function McpHealthIndicator() {
  const [data, setData] = useState<McpHealthResponse | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { openHelp } = useHelp();

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      let delay = 15_000;
      try {
        const res = await fetch("/api/mcp-health");
        if (res.ok) {
          const json = (await res.json()) as McpHealthResponse;
          if (!alive) return;
          setData(json);
          // Poll quickly while background probes are still resolving.
          if (json.enabled && json.pending > 0) delay = 2_000;
        }
      } catch {
        /* transient — retry on the default cadence */
      }
      if (alive) timer = setTimeout(tick, delay);
    };

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Close the popover on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!data || !data.enabled) return null;

  // Keyed by opaque server identity (unique across same-name servers from
  // different sources); render values, key React elements by that identity.
  const entries = Object.entries(data.servers).sort(([, a], [, b]) => {
    const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    return s !== 0 ? s : a.name.localeCompare(b.name);
  });
  if (entries.length === 0) return null; // probing — avoid a flash of an empty strip

  const downCount = entries.filter(([, s]) => s.status === "down").length;
  const unknownCount = entries.filter(([, s]) => s.status === "unknown").length;

  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <button
        type="button"
        className="mcp-health-strip"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`MCP servers — ${entries.length} configured${downCount > 0 ? `, ${downCount} down` : ""}`}
        title="MCP server health — click for details"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          whiteSpace: "nowrap",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: "2px 4px",
          borderRadius: 6,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: "0.04em",
            color: "var(--text-3)",
          }}
        >
          MCP
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {entries.map(([id, s]) => (
            <span
              key={id}
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: DOT_COLOR[s.status],
                display: "inline-block",
                flexShrink: 0,
              }}
            />
          ))}
        </div>
        {downCount > 0 && (
          <span style={{ fontSize: 10, color: "var(--danger, #f85149)" }}>{downCount} down</span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="MCP server health"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 50,
            width: 340,
            maxHeight: 420,
            overflowY: "auto",
            background: "var(--surface-1, #161b22)",
            border: "1px solid var(--border, #30363d)",
            borderRadius: 10,
            boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
            padding: 10,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
              paddingBottom: 8,
              borderBottom: "1px solid var(--border, #30363d)",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-1, #e6edf3)" }}>
              MCP servers
              <span style={{ color: "var(--text-3)", fontWeight: 400 }}> · {entries.length}</span>
            </span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openHelp("mcp-health");
              }}
              aria-label="About MCP server health"
              title="About MCP server health"
              style={{
                background: "transparent",
                border: "1px solid var(--border, #30363d)",
                color: "var(--text-3)",
                borderRadius: 6,
                width: 20,
                height: 20,
                fontSize: 11,
                lineHeight: 1,
                cursor: "pointer",
              }}
            >
              ?
            </button>
          </div>

          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {entries.map(([id, s]) => (
              <li key={id} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: DOT_COLOR[s.status],
                    flexShrink: 0,
                    marginTop: 5,
                  }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                    <span
                      style={{
                        fontSize: 12.5,
                        fontWeight: 500,
                        color: "var(--text-1, #e6edf3)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.name}
                    </span>
                    <span style={{ fontSize: 10.5, color: DOT_COLOR[s.status], flexShrink: 0 }}>
                      {STATUS_LABEL[s.status]}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
                    <Chip>{s.transport}</Chip>
                    <Chip>{s.source}</Chip>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 3, wordBreak: "break-word" }}>
                    {s.detail}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div
            style={{
              marginTop: 8,
              paddingTop: 8,
              borderTop: "1px solid var(--border, #30363d)",
              fontSize: 10.5,
              color: "var(--text-3)",
            }}
          >
            {entries.length - downCount - unknownCount} up · {downCount} down · {unknownCount} unknown
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color: "var(--text-3)",
        border: "1px solid var(--border, #30363d)",
        borderRadius: 4,
        padding: "0 5px",
        lineHeight: "16px",
      }}
    >
      {children}
    </span>
  );
}
