"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import type { Swarm } from "@/lib/tasks/types";
import { SwarmComposer } from "@/components/SwarmComposer";

const STATUS_COLORS: Record<string, string> = {
  running:   "var(--info, #60a5fa)",
  done:      "var(--success, #22c55e)",
  failed:    "var(--error)",
  cancelled: "var(--text-muted)",
};

export default function SwarmsPage() {
  useDocumentTitle("Swarms");
  const [swarms, setSwarms] = useState<Swarm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/swarms");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { swarms: Swarm[] };
      setSwarms(data.swarms);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load swarms");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div style={{ padding: "48px 0", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
        Loading swarms…
      </div>
    );
  }

  return (
    <div style={{ padding: "24px", maxWidth: "900px", margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <h1 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700 }}>Swarms</h1>
        <button
          onClick={() => setComposerOpen(true)}
          style={{
            padding: "6px 14px",
            background: "var(--accent)",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "0.82rem",
            fontWeight: 600,
            color: "#fff",
          }}
        >
          Launch Swarm
        </button>
      </div>

      {error && (
        <div style={{ color: "var(--error)", fontSize: "0.85rem", marginBottom: "16px" }}>{error}</div>
      )}

      {swarms.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 0", color: "var(--text-muted)", fontSize: "0.85rem" }}>
          <div style={{ fontSize: "2rem", marginBottom: "8px" }}>⚡</div>
          <div style={{ fontWeight: 500, marginBottom: "4px" }}>No swarms yet</div>
          <div style={{ fontSize: "0.75rem" }}>
            Launch a swarm to dispatch multiple tasks concurrently with an optional coordinator.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {swarms.map((s) => (
            <Link
              key={s.id}
              href={`/swarms/${s.id}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "12px 16px",
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                textDecoration: "none",
                color: "var(--text-primary)",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: STATUS_COLORS[s.status] ?? "var(--text-muted)",
                  flexShrink: 0,
                }}
              />
              <span style={{ fontWeight: 600, fontSize: "0.88rem", flex: 1 }}>{s.name}</span>
              <span
                style={{
                  fontSize: "0.7rem",
                  padding: "2px 6px",
                  borderRadius: "3px",
                  background: "var(--bg-elevated, var(--bg-card))",
                  border: "1px solid var(--border)",
                  color: "var(--text-muted)",
                }}
              >
                {s.mode}
              </span>
              <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                {s.status}
              </span>
              <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                {new Date(s.created_at).toLocaleString()}
              </span>
            </Link>
          ))}
        </div>
      )}

      <SwarmComposer
        open={composerOpen}
        onClose={() => { setComposerOpen(false); load(); }}
      />
    </div>
  );
}
