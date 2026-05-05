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

// ── Primitives ────────────────────────────────────────────────────────────────

function relPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const srcIdx = normalized.indexOf("/src/");
  if (srcIdx !== -1) return normalized.slice(srcIdx + 1);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash !== -1 ? normalized.slice(lastSlash + 1) : normalized;
}

function Bar({ pct, color, height = 4 }: { pct: number; color: string; height?: number }) {
  return (
    <div style={{ height: `${height}px`, background: "var(--bg-elevated)", borderRadius: "2px", overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: "2px" }} />
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
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
      {children}
    </h3>
  );
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
      <Bar pct={pct} color="var(--accent)" />
    </div>
  );
}

function HotFileRow({ file, max }: { file: HotFile; max: number }) {
  const label = relPath(file.filePath);
  const opsLabel = [
    file.ops.write > 0 && `${file.ops.write}w`,
    file.ops.edit > 0 && `${file.ops.edit}e`,
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

const monoEllipsis = {
  fontFamily: "var(--font-mono)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
};

function PairRow({ pair, max }: { pair: FilePair; max: number }) {
  const pct = max > 0 ? (pair.coOccurrences / max) * 100 : 0;
  return (
    <div style={{ marginBottom: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
        <div style={{ flex: 1, marginRight: "12px", overflow: "hidden" }}>
          <div style={{ ...monoEllipsis, fontSize: "0.72rem", color: "var(--text-primary)" }} title={pair.fileA}>
            {relPath(pair.fileA)}
          </div>
          <div style={{ ...monoEllipsis, fontSize: "0.68rem", color: "var(--text-secondary)" }} title={pair.fileB}>
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
      <Bar pct={pct} color="var(--status-active-text)" height={3} />
    </div>
  );
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

// ── Main component ────────────────────────────────────────────────────────────

export function HotFilesPanel({ slug }: HotFilesPanelProps) {
  const [hotData, setHotData] = useState<HotFilesResponse | null>(null);
  const [couplingData, setCouplingData] = useState<FileCouplingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setHotData(null);
    setCouplingData(null);
    Promise.all([
      fetchJson<HotFilesResponse>(`/api/projects/${slug}/hot-files`, controller.signal),
      fetchJson<FileCouplingResponse>(`/api/projects/${slug}/file-coupling`, controller.signal),
    ])
      .then(([hot, coupling]) => {
        setHotData(hot);
        setCouplingData(coupling);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
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
        <SectionLabel>Hot Files — most edited</SectionLabel>
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
        <SectionLabel>File Coupling — co-edited pairs</SectionLabel>
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
