"use client";

import { useState, useCallback, useRef } from "react";
import { Play, Download, Clock } from "lucide-react";
import { SqlSchemaSidebar } from "./SqlSchemaSidebar";
import { SqlResultsTable } from "./SqlResultsTable";
import { useSqlHistory } from "@/hooks/useSqlHistory";
import { toCsv } from "@/lib/csv";
import { downloadBlob } from "@/lib/downloadBlob";

interface SqlResult {
  rows: Record<string, unknown>[];
  columns: string[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

export function SqlBrowser() {
  const [sql, setSql] = useState("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;");
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { history, pushHistory } = useSqlHistory();

  const runQuery = useCallback(async () => {
    const trimmed = sql.trim();
    if (!trimmed || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/sql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        setResult(data as SqlResult);
        pushHistory(trimmed);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setRunning(false);
    }
  }, [sql, running, pushHistory]);

  function insertSql(snippet: string) {
    setSql(snippet);
    textareaRef.current?.focus();
  }

  function exportCsv() {
    if (!result) return;
    const content = toCsv(result.rows, result.columns);
    downloadBlob(content, "query-results.csv", "text/csv;charset=utf-8");
  }

  function exportJson() {
    if (!result) return;
    downloadBlob(
      JSON.stringify(result.rows, null, 2),
      "query-results.json",
      "application/json"
    );
  }

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
      <SqlSchemaSidebar onInsert={insertSql} />

      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        {/* Editor pane */}
        <div
          style={{
            padding: "12px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <textarea
            ref={textareaRef}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                runQuery();
              }
            }}
            spellCheck={false}
            rows={6}
            placeholder="SELECT * FROM sessions LIMIT 10;"
            style={{
              width: "100%",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "8px 10px",
              fontSize: "0.8rem",
              fontFamily: "var(--font-mono)",
              color: "var(--text-primary)",
              resize: "vertical",
              outline: "none",
              lineHeight: 1.5,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              onClick={runQuery}
              disabled={running}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "5px",
                padding: "5px 12px",
                background: running ? "var(--surface-2)" : "var(--info)",
                color: running ? "var(--text-muted)" : "#fff",
                border: "none",
                borderRadius: "var(--radius)",
                fontSize: "0.75rem",
                fontFamily: "var(--font-body)",
                fontWeight: 600,
                cursor: running ? "not-allowed" : "pointer",
              }}
            >
              <Play style={{ width: "12px", height: "12px" }} />
              {running ? "Running…" : "Run"}
            </button>
            <span
              style={{
                fontSize: "0.68rem",
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              ⌘/Ctrl+Enter
            </span>

            {result && result.rows.length > 0 && (
              <>
                <button
                  onClick={exportCsv}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "4px 10px",
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    fontSize: "0.72rem",
                    fontFamily: "var(--font-body)",
                    cursor: "pointer",
                    color: "var(--text-secondary)",
                  }}
                >
                  <Download style={{ width: "11px", height: "11px" }} />
                  CSV
                </button>
                <button
                  onClick={exportJson}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "4px 10px",
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    fontSize: "0.72rem",
                    fontFamily: "var(--font-body)",
                    cursor: "pointer",
                    color: "var(--text-secondary)",
                  }}
                >
                  <Download style={{ width: "11px", height: "11px" }} />
                  JSON
                </button>
              </>
            )}

            {history.length > 0 && (
              <div style={{ marginLeft: "auto", position: "relative" }}>
                <button
                  onClick={() => setHistoryOpen((o) => !o)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "4px 8px",
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    fontSize: "0.72rem",
                    fontFamily: "var(--font-body)",
                    cursor: "pointer",
                    color: "var(--text-secondary)",
                  }}
                >
                  <Clock style={{ width: "11px", height: "11px" }} />
                  History ({history.length})
                </button>
                {historyOpen && (
                  <div
                    style={{
                      position: "absolute",
                      right: 0,
                      top: "calc(100% + 4px)",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius)",
                      boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                      zIndex: 50,
                      width: "400px",
                      maxHeight: "300px",
                      overflowY: "auto",
                    }}
                  >
                    {history.map((entry, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          setSql(entry);
                          setHistoryOpen(false);
                          textareaRef.current?.focus();
                        }}
                        style={{
                          display: "block",
                          width: "100%",
                          padding: "6px 10px",
                          textAlign: "left",
                          background: "none",
                          border: "none",
                          borderBottom: "1px solid var(--border)",
                          cursor: "pointer",
                          fontSize: "0.72rem",
                          fontFamily: "var(--font-mono)",
                          color: "var(--text-secondary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={entry}
                      >
                        {entry}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div
            style={{
              padding: "8px 12px",
              background: "var(--error-bg, #2a0000)",
              borderBottom: "1px solid var(--border)",
              fontSize: "0.78rem",
              fontFamily: "var(--font-mono)",
              color: "var(--error, #f87171)",
            }}
          >
            {error === "db unavailable"
              ? "Database not initialized — visit Setup to enable the SQLite index."
              : `Error: ${error}`}
          </div>
        )}

        {/* Results area */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {result ? (
            <SqlResultsTable
              rows={result.rows}
              columns={result.columns}
              truncated={result.truncated}
              durationMs={result.durationMs}
              rowCount={result.rowCount}
            />
          ) : !error && !running ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-muted)",
                fontSize: "0.8rem",
                fontFamily: "var(--font-body)",
              }}
            >
              Run a query to see results
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
