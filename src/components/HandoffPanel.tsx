"use client";

import React, { useEffect, useState } from "react";
import type { HandoffFacts, CompactionFidelity } from "@/lib/usage/sessionHandoff";

interface HandoffResponse {
  sessionId: string;
  facts: HandoffFacts;
  fidelity: CompactionFidelity | null;
  doc: string;
  meta: { durationMs: number };
}

interface HandoffPanelProps {
  sessionId: string;
  onOpenDocModal?: () => void;
}

// ── Primitives ─────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.72rem",
        fontWeight: 600,
        textTransform: "uppercase" as const,
        letterSpacing: "0.06em",
        color: "var(--text-muted)",
        marginBottom: "10px",
      }}
    >
      {children}
    </h3>
  );
}

function FactList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return (
      <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", fontStyle: "italic" }}>
        None
      </p>
    );
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {items.map((item, i) => (
        <li
          key={i}
          title={item}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            marginBottom: "4px",
          }}
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

function FidelityCard({ fidelity }: { fidelity: CompactionFidelity }) {
  const pct = Math.round(fidelity.score * 100);
  const color = fidelity.isLowFidelity ? "var(--status-error-text)" : "var(--status-active-text)";
  return (
    <div
      style={{
        border: `1px solid ${fidelity.isLowFidelity ? "var(--status-error-border)" : "var(--border)"}`,
        borderRadius: "6px",
        padding: "14px 16px",
        background: fidelity.isLowFidelity ? "var(--status-error-bg)" : "var(--bg-elevated)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <SectionLabel>Compaction Fidelity</SectionLabel>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.9rem",
            fontWeight: 700,
            color,
          }}
        >
          {pct}%
        </span>
      </div>
      <p style={{ fontSize: "0.78rem", color: "var(--text-secondary)", marginBottom: fidelity.isLowFidelity ? "10px" : 0 }}>
        {fidelity.factsMentioned}/{fidelity.factsTotal} facts mentioned in the compaction summary.
        {fidelity.isLowFidelity && " Low fidelity — important context may have been omitted."}
      </p>
      {fidelity.isLowFidelity && fidelity.missingFacts.length > 0 && (
        <div>
          <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: "4px" }}>
            Omitted:
          </p>
          <FactList items={fidelity.missingFacts} />
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function HandoffPanel({ sessionId, onOpenDocModal }: HandoffPanelProps) {
  const [data, setData] = useState<HandoffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/sessions/${sessionId}/handoff?verbosity=standard`, {
      signal: controller.signal,
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<HandoffResponse>;
      })
      .then(setData)
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [sessionId]);

  if (loading) {
    return (
      <div style={{ padding: "32px 0", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
        Extracting handoff facts…
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: "24px", color: "var(--status-error-text)", fontSize: "0.85rem" }}>
        Failed to load handoff: {error}
      </div>
    );
  }
  if (!data) return null;

  const { facts, fidelity } = data;
  const commitLines = facts.gitCommits.map((c) => c.message);
  const filePaths = facts.filesModified.map((f) => f.split(/[/\\]/).pop() ?? f);

  return (
    <div style={{ padding: "24px" }}>
      {onOpenDocModal && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "20px" }}>
          <button
            onClick={onOpenDocModal}
            style={{
              padding: "6px 14px",
              fontSize: "0.78rem",
              fontWeight: 500,
              border: "1px solid var(--border)",
              borderRadius: "5px",
              background: "var(--bg-elevated)",
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
          >
            Generate handoff doc
          </button>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "24px", marginBottom: "24px" }}>
        <div>
          <SectionLabel>Files Modified ({facts.filesModified.length})</SectionLabel>
          <FactList items={filePaths} />
        </div>
        <div>
          <SectionLabel>Git Commits ({facts.gitCommits.length})</SectionLabel>
          <FactList items={commitLines} />
        </div>
        <div>
          <SectionLabel>Key Commands ({facts.keyCommands.length})</SectionLabel>
          <FactList items={facts.keyCommands} />
        </div>
      </div>

      {fidelity && <FidelityCard fidelity={fidelity} />}

      {!fidelity && (
        <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", fontStyle: "italic" }}>
          No compaction summary found — fidelity score not available.
        </p>
      )}
    </div>
  );
}
