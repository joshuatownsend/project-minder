"use client";

import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { SQL_SCHEMA } from "@/lib/sqlSchemaSnapshot";

interface SqlSchemaSidebarProps {
  onInsert: (sql: string) => void;
}

export function SqlSchemaSidebar({ onInsert }: SqlSchemaSidebarProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(table: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  }

  return (
    <aside
      style={{
        width: "200px",
        flexShrink: 0,
        borderRight: "1px solid var(--border)",
        overflowY: "auto",
        fontSize: "0.72rem",
        fontFamily: "var(--font-mono)",
      }}
    >
      <div
        style={{
          padding: "8px 10px",
          fontSize: "0.65rem",
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        Schema
      </div>
      {SQL_SCHEMA.map((entry) => {
        const open = expanded.has(entry.table);
        return (
          <div key={entry.table}>
            <button
              onClick={() => toggle(entry.table)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                width: "100%",
                padding: "4px 8px",
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--text-secondary)",
                fontSize: "0.72rem",
                fontFamily: "var(--font-mono)",
                textAlign: "left",
                borderBottom: "1px solid transparent",
              }}
              title={`SELECT * FROM "${entry.table}" LIMIT 100`}
              onDoubleClick={() => onInsert(`SELECT * FROM "${entry.table}" LIMIT 100;`)}
            >
              {open ? (
                <ChevronDown style={{ width: "10px", height: "10px", flexShrink: 0 }} />
              ) : (
                <ChevronRight style={{ width: "10px", height: "10px", flexShrink: 0 }} />
              )}
              <span
                style={{
                  color: entry.virtual ? "var(--text-muted)" : "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {entry.table}
              </span>
              {entry.virtual && (
                <span style={{ color: "var(--text-muted)", fontSize: "0.6rem" }}>fts</span>
              )}
            </button>
            {open && (
              <div style={{ paddingLeft: "20px", paddingBottom: "4px" }}>
                {entry.columns.map((col) => (
                  <div
                    key={col}
                    style={{
                      padding: "1px 4px",
                      color: "var(--text-muted)",
                      fontSize: "0.68rem",
                    }}
                  >
                    {col}
                  </div>
                ))}
                <button
                  onClick={() => onInsert(`SELECT * FROM "${entry.table}" LIMIT 100;`)}
                  style={{
                    marginTop: "4px",
                    padding: "2px 6px",
                    fontSize: "0.64rem",
                    fontFamily: "var(--font-mono)",
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                    borderRadius: "3px",
                    cursor: "pointer",
                    color: "var(--text-secondary)",
                  }}
                >
                  ↗ insert SELECT
                </button>
              </div>
            )}
          </div>
        );
      })}
    </aside>
  );
}
