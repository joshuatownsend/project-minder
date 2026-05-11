"use client";

import { useMemo } from "react";
import { diffMemoryBodies } from "@/lib/memory/seedDiff";

export function MemorySeedDiff({ existing, proposed }: { existing: string; proposed: string }) {
  const summary = useMemo(() => diffMemoryBodies(existing, proposed), [existing, proposed]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "6px 10px",
          fontSize: "0.66rem",
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border-subtle)",
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.04em",
        }}
      >
        +{summary.added} −{summary.removed} ={summary.equal}
      </div>
      <div style={{ maxHeight: "400px", overflow: "auto", fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>
        {summary.segments.map((s, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              gap: "8px",
              padding: "1px 10px",
              background: BG[s.op],
              color: FG[s.op],
              whiteSpace: "pre",
            }}
          >
            <span style={{ width: "16px", color: "var(--text-muted)", textAlign: "center" }}>
              {GLYPH[s.op]}
            </span>
            <span style={{ flex: 1 }}>{s.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const BG: Record<"equal" | "added" | "removed", string> = {
  equal: "transparent",
  added: "color-mix(in srgb, var(--status-success, #10b981) 14%, transparent)",
  removed: "color-mix(in srgb, var(--accent) 12%, transparent)",
};

const FG: Record<"equal" | "added" | "removed", string> = {
  equal: "var(--text-secondary)",
  added: "var(--text-primary)",
  removed: "var(--text-secondary)",
};

const GLYPH: Record<"equal" | "added" | "removed", string> = {
  equal: " ",
  added: "+",
  removed: "−",
};
