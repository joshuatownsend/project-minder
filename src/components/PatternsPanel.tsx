"use client";

import { useEffect, useState } from "react";
import type { WorkflowPattern } from "@/lib/usage/workflowPatterns";
import { SectionLabel } from "@/components/ui/section-label";

interface PatternsResponse {
  patterns: WorkflowPattern[];
  totalSessionsConsidered: number;
  totalBashCalls: number;
  meta: { cachedAt: number; jsonlMtime: number };
}

interface PatternsPanelProps {
  slug: string;
}

function BinaryChip({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 7px",
        borderRadius: "3px",
        border: "1px solid var(--border)",
        background: "var(--bg-elevated)",
        fontFamily: "var(--font-mono)",
        fontSize: "0.68rem",
        color: "var(--text-secondary)",
        marginRight: "4px",
      }}
    >
      {label}
    </span>
  );
}

function PatternRow({ pattern }: { pattern: WorkflowPattern }) {
  return (
    <div
      style={{
        padding: "12px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
        {/* Binary sequence chips */}
        <div style={{ flex: 1 }}>
          <div style={{ marginBottom: "6px" }}>
            {pattern.binaries.map((b, i) => (
              <BinaryChip key={i} label={b} />
            ))}
          </div>
          {pattern.suggestedSkillName && !pattern.matchedSkill && (
            <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
              Suggested skill:{" "}
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
                {pattern.suggestedSkillName}
              </span>
            </div>
          )}
          {pattern.matchedSkill && (
            <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
              Matches skill:{" "}
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--status-active-text)",
                  fontSize: "0.72rem",
                }}
              >
                {pattern.matchedSkill.name}
              </span>
              {pattern.matchedSkill.invocations > 0 && (
                <span> · {pattern.matchedSkill.invocations} invocations</span>
              )}
            </div>
          )}
        </div>

        {/* Stats */}
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.82rem",
              fontWeight: 600,
              color: "var(--text-primary)",
            }}
          >
            {pattern.occurrences} sessions
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.68rem",
              color: "var(--text-muted)",
            }}
          >
            {pattern.totalRuns} runs
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function PatternsPanel({ slug }: PatternsPanelProps) {
  const [data, setData] = useState<PatternsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/projects/${slug}/patterns`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<PatternsResponse>;
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
  }, [slug]);

  if (loading) {
    return (
      <div style={{ padding: "32px 0", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
        Detecting workflow patterns…
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: "24px", color: "var(--status-error-text)", fontSize: "0.85rem" }}>
        Failed to load patterns: {error}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div style={{ padding: "24px" }}>
      {data.patterns.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 0" }}>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            No recurring workflow patterns detected.
          </p>
          <p style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginTop: "6px" }}>
            Patterns appear after a Bash sequence recurs across 3+ sessions.
          </p>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "20px" }}>
            <SectionLabel>Recurring Workflows</SectionLabel>
            <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
              {data.patterns.length} pattern{data.patterns.length !== 1 ? "s" : ""} across {data.totalSessionsConsidered} sessions
            </span>
          </div>
          <div>
            {data.patterns.map((p) => (
              <PatternRow key={p.fingerprint} pattern={p} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
