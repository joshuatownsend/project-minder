"use client";

import { useEffect, useState } from "react";
import type { HotFilesResult, HotFile } from "@/lib/usage/fileTracker";
import type { FileCouplingResult, FilePair } from "@/lib/usage/fileCoupling";

interface HotFilesResponse {
  slug: string;
  result: HotFilesResult;
  generatedAt: string;
}

interface FileCouplingResponse {
  slug: string;
  result: FileCouplingResult;
  generatedAt: string;
}

interface HotFilesPanelProps {
  slug: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relPath(filePath: string): string {
  // Strip everything up to and including the project slug dir so the displayed
  // path is relative (e.g. "src/lib/usage/parser.ts" not the full Windows path).
  const normalized = filePath.replace(/\\/g, "/");
  const srcIdx = normalized.indexOf("/src/");
  if (srcIdx !== -1) return normalized.slice(srcIdx + 1);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash !== -1 ? normalized.slice(lastSlash + 1) : normalized;
}

function BarRow({
  label,
  value,
  max,
  sub,
}: {
  label: string;
  value: number;
  max: number;
  sub?: string;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div style={{ marginBottom: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            marginRight: "12px",
          }}
          title={label}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            color: "var(--text-secondary)",
            flexShrink: 0,
          }}
        >
          {value}
          {sub && (
            <span style={{ color: "var(--text-muted)", marginLeft: "4px" }}>{sub}</span>
          )}
        </span>
      </div>
      <div
        style={{
          height: "4px",
          background: "var(--bg-elevated)",
          borderRadius: "2px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "var(--accent)",
            borderRadius: "2px",
          }}
        />
      </div>
    </div>
  );
}

function HotFileRow({ file, max }: { file: HotFile; max: number }) {
  const label = relPath(file.filePath);
  const opsLabel = [
    file.ops.write > 0 && `${file.ops.write}w`,
    file.ops.edit > 0 && `${file.ops.edit}e`,
    file.ops.delete > 0 && `${file.ops.delete}d`,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <BarRow
      label={label}
      value={file.editCount}
      max={max}
      sub={`${file.sessionCount} sess · ${opsLabel}`}
    />
  );
}

function PairRow({ pair, max }: { pair: FilePair; max: number }) {
  const pct = max > 0 ? (pair.coOccurrences / max) * 100 : 0;
  return (
    <div style={{ marginBottom: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
        <div style={{ flex: 1, marginRight: "12px", overflow: "hidden" }}>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.72rem",
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={pair.fileA}
          >
            {relPath(pair.fileA)}
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.68rem",
              color: "var(--text-secondary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={pair.fileB}
          >
            + {relPath(pair.fileB)}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-secondary)" }}>
            {pair.coOccurrences}×
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-muted)" }}>
            {(pair.strength * 100).toFixed(0)}%
          </div>
        </div>
      </div>
      <div
        style={{
          height: "3px",
          background: "var(--bg-elevated)",
          borderRadius: "2px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "var(--status-active-text)",
            borderRadius: "2px",
          }}
        />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function HotFilesPanel({ slug }: HotFilesPanelProps) {
  const [hotData, setHotData] = useState<HotFilesResponse | null>(null);
  const [couplingData, setCouplingData] = useState<FileCouplingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/api/projects/${slug}/hot-files`).then((r) => r.json()),
      fetch(`/api/projects/${slug}/file-coupling`).then((r) => r.json()),
    ])
      .then(([hot, coupling]) => {
        setHotData(hot);
        setCouplingData(coupling);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div style={{ padding: "32px 0", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
        Analyzing file activity…
      </div>
    );
  }

  if (error || !hotData?.result || !couplingData?.result) {
    return (
      <div style={{ padding: "32px 0", textAlign: "center", color: "var(--status-error-text)", fontSize: "0.85rem" }}>
        {error ?? "Failed to load file activity data."}
      </div>
    );
  }

  const { hotFiles, totalFiles, totalEdits } = hotData.result;
  const { pairs, totalSessions } = couplingData.result;
  const maxEdits = hotFiles[0]?.editCount ?? 1;
  const maxCoOccurrences = pairs[0]?.coOccurrences ?? 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Summary strip */}
      <div
        style={{
          display: "flex",
          gap: "20px",
          background: "var(--bg-elevated)",
          borderRadius: "var(--radius)",
          padding: "12px 16px",
          flexWrap: "wrap",
        }}
      >
        {[
          { label: "unique files edited", value: totalFiles },
          { label: "total edit ops", value: totalEdits },
          { label: "sessions analysed", value: totalSessions },
        ].map(({ label, value }) => (
          <div key={label}>
            <div
              style={{ fontFamily: "var(--font-mono)", fontSize: "1.1rem", fontWeight: 600, color: "var(--text-primary)" }}
            >
              {value.toLocaleString()}
            </div>
            <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Hot files */}
      <section>
        <h3
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--text-muted)",
            marginBottom: "12px",
          }}
        >
          Hot Files — most edited
        </h3>
        {hotFiles.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            No file edits recorded yet for this project.
          </p>
        ) : (
          hotFiles.map((f) => (
            <HotFileRow key={f.filePath} file={f} max={maxEdits} />
          ))
        )}
      </section>

      {/* Coupling */}
      <section>
        <h3
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--text-muted)",
            marginBottom: "12px",
          }}
        >
          File Coupling — co-edited pairs
        </h3>
        {pairs.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            No co-edited file pairs found (minimum 2 sessions required).
          </p>
        ) : (
          pairs.slice(0, 20).map((p) => (
            <PairRow key={p.fileA + "\0" + p.fileB} pair={p} max={maxCoOccurrences} />
          ))
        )}
      </section>
    </div>
  );
}
