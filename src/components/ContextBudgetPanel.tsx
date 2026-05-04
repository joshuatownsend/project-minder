"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

interface BudgetBreakdown {
  systemBaseTokens: number;
  mcpServerCount: number;
  mcpServerTokens: number;
  skillCount: number;
  skillTokens: number;
  memoryChars: number;
  memoryTokens: number;
  totalTokens: number;
  estimatedUsd: number | null;
  pricingModel?: string;
  detail: {
    mcpServers: Array<{ name: string; source: string; transport: string }>;
    memoryFiles: Array<{ path: string; chars: number }>;
    skillsBySource: { user: number; plugin: number; project: number };
  };
}

interface Props {
  slug: string;
  /** Default expanded state. */
  defaultExpanded?: boolean;
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

function fmtUsd(n: number | null): string {
  if (n === null) return "—";
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

export function ContextBudgetPanel({ slug, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [data, setData] = useState<BudgetBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded || data || loading) return;
    setLoading(true);
    setError(null);
    fetch(`/api/projects/${slug}/context-budget`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((b: BudgetBreakdown) => setData(b))
      .catch((err) => setError(err instanceof Error ? err.message : "Load failed"))
      .finally(() => setLoading(false));
  }, [expanded, data, loading, slug]);

  return (
    <div style={{
      padding: "12px 16px",
      background: "var(--bg-elevated)",
      border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius)",
      display: "flex", flexDirection: "column", gap: "10px",
    }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: "8px",
          padding: 0, background: "none", border: "none",
          cursor: "pointer", textAlign: "left",
        }}
      >
        {expanded ? (
          <ChevronDown style={{ width: "12px", height: "12px", color: "var(--text-muted)" }} />
        ) : (
          <ChevronRight style={{ width: "12px", height: "12px", color: "var(--text-muted)" }} />
        )}
        <span style={{
          fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.1em",
          textTransform: "uppercase", color: "var(--text-muted)",
          fontFamily: "var(--font-body)",
        }}>
          Context overhead estimate
        </span>
        {data && (
          <span style={{
            marginLeft: "auto",
            fontSize: "0.72rem", fontFamily: "var(--font-mono)",
            color: "var(--text-secondary)",
          }}>
            ~{fmtTokens(data.totalTokens)} tokens
            {data.estimatedUsd !== null && ` · ${fmtUsd(data.estimatedUsd)}`}
          </span>
        )}
      </button>

      {expanded && loading && (
        <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", margin: 0 }}>
          Computing…
        </p>
      )}
      {expanded && error && (
        <p style={{ fontSize: "0.72rem", color: "var(--accent)", margin: 0 }}>
          {error}
        </p>
      )}
      {expanded && data && (
        <>
          <p style={{ fontSize: "0.7rem", color: "var(--text-muted)", margin: 0 }}>
            Tokens consumed by Claude Code's infrastructure (system prompt, MCP server descriptors,
            skill metadata, memory files) before any of your code is read.
          </p>
          <BudgetTable data={data} />
          {data.pricingModel && data.estimatedUsd !== null && (
            <p style={{
              fontSize: "0.66rem", color: "var(--text-muted)",
              fontFamily: "var(--font-body)", margin: 0,
            }}>
              Cost estimated at {data.pricingModel} input rate.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function BudgetTable({ data }: { data: BudgetBreakdown }) {
  const rows: Array<{ label: string; tokens: number; sub?: string }> = [
    { label: "System base", tokens: data.systemBaseTokens, sub: "fixed Claude Code overhead" },
    {
      label: "MCP servers",
      tokens: data.mcpServerTokens,
      sub: data.mcpServerCount > 0 ? `${data.mcpServerCount} × 400 tokens` : "none",
    },
    {
      label: "Skills in scope",
      tokens: data.skillTokens,
      sub: `${data.detail.skillsBySource.user} user · ${data.detail.skillsBySource.plugin} plugin · ${data.detail.skillsBySource.project} project`,
    },
    {
      label: "Memory files",
      tokens: data.memoryTokens,
      sub: data.memoryChars > 0 ? `${data.memoryChars.toLocaleString()} chars / 4` : "none",
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      {rows.map((r) => (
        <div key={r.label} style={{
          display: "flex", alignItems: "center", gap: "12px",
          paddingBottom: "4px",
          borderBottom: "1px dashed var(--border-subtle)",
        }}>
          <span style={{
            fontSize: "0.74rem", color: "var(--text-secondary)",
            fontFamily: "var(--font-body)", flex: 1,
          }}>
            {r.label}
            {r.sub && (
              <span style={{
                marginLeft: "8px",
                fontSize: "0.66rem", color: "var(--text-muted)",
              }}>
                {r.sub}
              </span>
            )}
          </span>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: "0.74rem",
            color: "var(--text-primary)",
          }}>
            {fmtTokens(r.tokens)}
          </span>
        </div>
      ))}
      <div style={{
        display: "flex", alignItems: "center", gap: "12px",
        paddingTop: "6px", marginTop: "2px",
      }}>
        <span style={{
          fontSize: "0.74rem", fontWeight: 600, color: "var(--text-primary)",
          fontFamily: "var(--font-body)", flex: 1,
        }}>
          Total
        </span>
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: "0.78rem",
          color: "var(--text-primary)", fontWeight: 600,
        }}>
          ~{fmtTokens(data.totalTokens)} tokens
        </span>
      </div>
    </div>
  );
}
