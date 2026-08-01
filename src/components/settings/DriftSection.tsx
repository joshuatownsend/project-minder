"use client";

import { useCallback, useEffect, useState } from "react";
import { S } from "./styles";

/**
 * Cross-harness drift, shown in Settings.
 *
 * Drift is a property of the machine's harness config homes, not of any one
 * project, so it belongs beside the adapter toggles that decide which
 * harnesses are compared — not in a per-project Config Lint tab.
 */

interface DriftFinding {
  code: string;
  kind: string;
  severity: string;
  title: string;
  fix: string;
}

interface DriftResponse {
  enabled: boolean;
  harnesses: { id: string; displayName: string; present: boolean; items: number }[];
  findings: DriftFinding[];
  reason?: string;
}

const KIND_LABEL: Record<string, string> = {
  mcp: "MCP servers",
  skill: "Skills",
  instruction: "Instruction files",
  other: "Other",
};

export function DriftSection() {
  const [data, setData] = useState<DriftResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // An unreachable endpoint, a non-2xx, or invalid JSON used to land in the
  // same `null` as "loaded fine, found nothing", so a failed check rendered
  // as "No divergence found — the compared harnesses agree." A failure has to
  // read as a failure, not as a clean bill of health.
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/drift")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as DriftResponse;
      })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        setData(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  if (!loading && !error && data && !data.enabled) return null;

  const byKind = new Map<string, DriftFinding[]>();
  for (const f of data?.findings ?? []) {
    const bucket = byKind.get(f.kind) ?? [];
    bucket.push(f);
    byKind.set(f.kind, bucket);
  }

  return (
    <div>
      <h2 style={S.sectionTitle}>Cross-harness drift</h2>
      <p style={S.desc}>
        What one coding harness has configured that another doesn&rsquo;t — MCP servers, skills, and
        instruction files across Claude Code, Codex, and Gemini CLI. Read-only: Minder never writes
        harness config, so nothing here changes on its own.
      </p>

      <div style={S.card}>
        {loading && <div style={S.muted}>Reading harness config homes…</div>}

        {!loading && data?.harnesses && data.harnesses.length > 0 && (
          <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", marginBottom: "14px" }}>
            {data.harnesses.map((h) => (
              <div key={h.id} style={S.muted}>
                <span style={{ ...S.label, marginRight: "6px" }}>{h.displayName}</span>
                {h.present ? `${h.items} items` : "not installed"}
              </div>
            ))}
          </div>
        )}

        {!loading && error && (
          <div style={{ ...S.muted, color: "var(--error, var(--text-secondary))" }}>
            Couldn&rsquo;t check for drift: {error}. This is not a clean result — nothing was compared.
          </div>
        )}

        {!loading && !error && data?.reason && <div style={S.muted}>{data.reason}</div>}

        {!loading && !error && data && !data.reason && data.findings.length === 0 && (
          <div style={S.muted}>No divergence found — the compared harnesses agree.</div>
        )}

        {!loading && !error &&
          [...byKind.entries()].map(([kind, findings]) => (
            <div key={kind} style={{ marginBottom: "14px" }}>
              <div style={{ ...S.label, marginBottom: "6px" }}>{KIND_LABEL[kind] ?? kind}</div>
              {findings.map((f, i) => (
                <div
                  key={`${f.code}-${i}`}
                  style={{
                    padding: "8px 10px",
                    marginBottom: "6px",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius)",
                    background: "var(--bg-elevated)",
                  }}
                >
                  <div style={{ fontSize: "0.8rem", color: "var(--text-primary)" }}>{f.title}</div>
                  <div style={{ ...S.muted, marginTop: "4px" }}>{f.fix}</div>
                </div>
              ))}
            </div>
          ))}

        {!loading && (
          <button
            onClick={load}
            style={{
              marginTop: "4px",
              padding: "6px 12px",
              fontSize: "0.78rem",
              background: "transparent",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              cursor: "pointer",
            }}
          >
            Re-check
          </button>
        )}
      </div>
    </div>
  );
}
