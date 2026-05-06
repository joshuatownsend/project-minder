"use client";

import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

interface SqlResultsTableProps {
  rows: Record<string, unknown>[];
  columns: string[];
  truncated: boolean;
  durationMs: number;
  rowCount: number;
}

const cellStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: "0.75rem",
  fontFamily: "var(--font-mono)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: "80px",
  maxWidth: "300px",
  flexShrink: 0,
};

export function SqlResultsTable({ rows, columns, truncated, durationMs, rowCount }: SqlResultsTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 8,
  });

  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: "24px",
          textAlign: "center",
          color: "var(--text-muted)",
          fontSize: "0.8rem",
          fontFamily: "var(--font-body)",
        }}
      >
        Query returned 0 rows in {durationMs}ms.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {truncated && (
        <div
          style={{
            padding: "6px 12px",
            background: "var(--warning-bg, #2a1f00)",
            borderBottom: "1px solid var(--border)",
            fontSize: "0.75rem",
            color: "var(--warning, #f59e0b)",
            fontFamily: "var(--font-body)",
          }}
        >
          Results truncated at {rowCount.toLocaleString()} rows. Add a LIMIT to see all results.
        </div>
      )}
      <div
        style={{
          padding: "4px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: "0.72rem",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {rowCount.toLocaleString()} row{rowCount !== 1 ? "s" : ""} · {durationMs}ms ·{" "}
        {columns.length} column{columns.length !== 1 ? "s" : ""}
      </div>

      {/* Single scroll container — header and body share the same horizontal scroll axis */}
      <div ref={parentRef} style={{ flex: 1, overflow: "auto" }}>
        {/* Sticky header — scrolls horizontally with body, pins vertically */}
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 1,
            background: "var(--surface-2)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ display: "flex", minWidth: "max-content" }}>
            {columns.map((col) => (
              <div
                key={col}
                style={{ ...cellStyle, fontWeight: 600, color: "var(--text-secondary)" }}
              >
                {col}
              </div>
            ))}
          </div>
        </div>

        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          {virtualizer.getVirtualItems().map((vItem) => {
            const row = rows[vItem.index];
            return (
              <div
                key={vItem.key}
                data-index={vItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  transform: `translateY(${vItem.start}px)`,
                  display: "flex",
                  minWidth: "max-content",
                  borderBottom: "1px solid var(--border-subtle, var(--border))",
                }}
              >
                {columns.map((col) => {
                  const val = row[col];
                  return (
                    <div
                      key={col}
                      style={{
                        ...cellStyle,
                        color:
                          val === null || val === undefined
                            ? "var(--text-muted)"
                            : "var(--text-primary)",
                      }}
                      title={val === null || val === undefined ? "NULL" : String(val)}
                    >
                      {val === null || val === undefined ? (
                        <span style={{ fontStyle: "italic" }}>NULL</span>
                      ) : (
                        String(val)
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
