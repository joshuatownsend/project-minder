"use client";

import { useEffect, useState } from "react";
import type { HarnessConfig } from "@/lib/adapters/types";

// Read-only render of a harness's config home (item 1). Secrets are already
// redacted server-side (the parsed object is what arrives); this component just
// presents it. Note the deliberate absence of any edit/share affordance.

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px", margin: "0 0 12px" }}>
      <span style={{
        fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.1em",
        textTransform: "uppercase", color: "var(--text-muted)", fontFamily: "var(--font-body)",
        whiteSpace: "nowrap",
      }}>
        {label}
      </span>
      <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
    </div>
  );
}

const MONO = "var(--font-mono)";

function scalarColor(v: unknown): string {
  if (typeof v === "boolean") return "var(--info)";
  if (typeof v === "number") return "var(--accent)";
  return "var(--text-secondary)";
}

function scalarText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (v === null) return "null";
  return String(v);
}

// Recursive key/value tree for the parsed TOML object. Indents nested tables;
// renders scalars inline. Arrays render their items in order.
function ConfigTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || typeof value !== "object") {
    return (
      <span style={{ fontFamily: MONO, fontSize: "0.72rem", color: scalarColor(value) }}>
        {scalarText(value)}
      </span>
    );
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);

  if (entries.length === 0) {
    return (
      <span style={{ fontFamily: MONO, fontSize: "0.72rem", color: "var(--text-muted)" }}>
        {Array.isArray(value) ? "[]" : "{}"}
      </span>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "3px", paddingLeft: depth > 0 ? "14px" : 0 }}>
      {entries.map(([k, v]) => {
        const nested = v !== null && typeof v === "object";
        return (
          <div
            key={k}
            style={{
              display: "flex",
              gap: "8px",
              alignItems: nested ? "flex-start" : "baseline",
              flexDirection: nested ? "column" : "row",
            }}
          >
            <span style={{
              fontFamily: MONO, fontSize: "0.72rem", fontWeight: 600,
              color: "var(--text-primary)", flexShrink: 0,
            }}>
              {k}
              {!nested && <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> =</span>}
            </span>
            <ConfigTree value={v} depth={depth + 1} />
          </div>
        );
      })}
    </div>
  );
}

function RuleBlock({ name, content, truncated }: { name: string; content: string; truncated: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)",
      background: "var(--bg-surface)", overflow: "hidden",
    }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%", textAlign: "left", padding: "8px 12px", cursor: "pointer",
          background: "transparent", border: "none",
          fontFamily: MONO, fontSize: "0.72rem", color: "var(--text-secondary)",
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}
      >
        <span>{name}</span>
        <span style={{ color: "var(--text-muted)", fontSize: "0.62rem" }}>
          {content.length.toLocaleString()} chars{truncated ? " (truncated)" : ""} · {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <pre style={{
          margin: 0, padding: "10px 12px", borderTop: "1px solid var(--border-subtle)",
          background: "var(--bg-elevated)", overflow: "auto", maxHeight: "320px",
          fontFamily: MONO, fontSize: "0.7rem", color: "var(--text-secondary)",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {content}
        </pre>
      )}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: "0 0 16px", fontFamily: "var(--font-body)" }}>
      {children}
    </p>
  );
}

export function HarnessConfigView({ harnessId }: { harnessId: string }) {
  const [data, setData] = useState<HarnessConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    fetch(`/api/adapters/${encodeURIComponent(harnessId)}/config`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        return res.json();
      })
      .then((d: HarnessConfig) => { setData(d); setLoading(false); })
      .catch((err) => {
        if (err.name !== "AbortError") { setError(err.message); setLoading(false); }
      });
    return () => controller.abort();
  }, [harnessId]);

  if (loading) return <Note>Loading harness config…</Note>;
  if (error) return <Note>{error}</Note>;
  if (!data) return <Note>No data.</Note>;

  if (!data.present) {
    return (
      <div>
        <Note>
          No config home found for <strong>{data.displayName}</strong>
          {data.home ? <> at <code style={{ fontFamily: MONO }}>{data.home}</code></> : null}.
        </Note>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <Note>
        Read-only view of <strong>{data.displayName}</strong>&apos;s config home
        {" "}(<code style={{ fontFamily: MONO }}>{data.home}</code>). Secrets — bearer tokens,
        API keys, env values, auth headers — are redacted; credential files aren&apos;t read.
      </Note>

      <div>
        <SectionHeader label="Configuration" />
        {data.parseError ? (
          <Note>{data.parseError}</Note>
        ) : data.config === null ? (
          <Note>No config file found in this harness home.</Note>
        ) : (
          <div style={{
            padding: "14px", background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)",
            overflow: "auto",
          }}>
            <ConfigTree value={data.config} />
          </div>
        )}
      </div>

      {data.rules.length > 0 && (
        <div>
          <SectionHeader label="Rules" />
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {data.rules.map((r) => (
              <RuleBlock key={r.name} name={r.name} content={r.content} truncated={r.truncated} />
            ))}
          </div>
        </div>
      )}

      {data.resources.length > 0 && (
        <div>
          <SectionHeader label="Resources" />
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {data.resources.map((res) => (
              <span
                key={res.name}
                style={{
                  fontFamily: MONO, fontSize: "0.68rem", padding: "3px 9px",
                  borderRadius: "var(--radius)", border: "1px solid",
                  color: res.present ? "var(--status-active-text)" : "var(--text-muted)",
                  background: res.present ? "var(--status-active-bg)" : "transparent",
                  borderColor: res.present ? "var(--status-active-border)" : "var(--border-subtle)",
                }}
              >
                {res.name}{res.present ? " ✓" : " —"}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
