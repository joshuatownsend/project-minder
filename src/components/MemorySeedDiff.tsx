"use client";

import { useMemo } from "react";
import { lineDiff, type DiffLine } from "@/lib/usage/diff";

export function MemorySeedDiff({ existing, proposed }: { existing: string; proposed: string }) {
  const lines = useMemo(() => lineDiff(existing, proposed), [existing, proposed]);
  const counts = useMemo(() => countByKind(lines), [lines]);

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
        +{counts.added} −{counts.removed} ={counts.context}
      </div>
      <div style={{ maxHeight: "400px", overflow: "auto", fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              gap: "8px",
              padding: "1px 10px",
              background: BG[line.kind],
              color: FG[line.kind],
              whiteSpace: "pre",
            }}
          >
            <span style={{ width: "16px", color: "var(--text-muted)", textAlign: "center" }}>
              {GLYPH[line.kind]}
            </span>
            <span style={{ flex: 1 }}>{line.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function countByKind(lines: DiffLine[]): { added: number; removed: number; context: number } {
  let added = 0;
  let removed = 0;
  let context = 0;
  for (const l of lines) {
    if (l.kind === "added") added++;
    else if (l.kind === "removed") removed++;
    else context++;
  }
  return { added, removed, context };
}

const BG: Record<DiffLine["kind"], string> = {
  context: "transparent",
  added: "color-mix(in srgb, var(--status-success, #10b981) 14%, transparent)",
  removed: "color-mix(in srgb, var(--accent) 12%, transparent)",
};

const FG: Record<DiffLine["kind"], string> = {
  context: "var(--text-secondary)",
  added: "var(--text-primary)",
  removed: "var(--text-secondary)",
};

const GLYPH: Record<DiffLine["kind"], string> = {
  context: " ",
  added: "+",
  removed: "−",
};
