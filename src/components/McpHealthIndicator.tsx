"use client";

import { useEffect, useState } from "react";
import type { McpHealth } from "@/lib/types";

/**
 * MCP integrations health strip (ported from agentic-os-dashboard). A compact
 * row of dots — one per user-scope MCP server — with a per-server tooltip.
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

const DOT_COLOR: Record<McpHealth["status"], string> = {
  up: "var(--ok, #3fb950)",
  down: "var(--danger, #f85149)",
  unknown: "var(--text-3, #7d8590)",
};

export function McpHealthIndicator() {
  const [data, setData] = useState<McpHealthResponse | null>(null);

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

  if (!data || !data.enabled) return null;

  const servers = Object.values(data.servers).sort((a, b) => a.name.localeCompare(b.name));
  if (servers.length === 0) return null; // probing — avoid a flash of an empty strip

  const downCount = servers.filter((s) => s.status === "down").length;

  return (
    <div
      className="mcp-health-strip"
      title={`MCP servers — ${servers.length} configured${downCount > 0 ? `, ${downCount} down` : ""}`}
      style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}
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
        {servers.map((s) => (
          <span
            key={s.name}
            title={`${s.name} — ${s.detail}`}
            aria-label={`${s.name}: ${s.status}`}
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
    </div>
  );
}
