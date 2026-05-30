"use client";

import { useEffect, useState } from "react";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { HarnessConfigView } from "@/components/HarnessConfigView";

interface AdapterEntry {
  id: string;
  displayName: string;
  enabled: boolean;
  hasConfig: boolean;
}

export default function AdaptersPage() {
  useDocumentTitle("Harnesses");
  const [adapters, setAdapters] = useState<AdapterEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/adapters")
      .then((r) => r.json())
      .then((data: AdapterEntry[]) => {
        setAdapters(data);
        const configurable = data.filter((a) => a.hasConfig && a.enabled);
        setSelected(configurable[0]?.id ?? null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  // Only harnesses that both expose a config surface AND are enabled
  // (enabledAdapters) are selectable — matching the API gate.
  const configurable = adapters.filter((a) => a.hasConfig && a.enabled);

  return (
    <div className="shell-content">
      <h1 style={{
        fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)",
        fontFamily: "var(--font-body)", letterSpacing: "-0.01em", margin: "0 0 20px",
      }}>
        Harness Config
      </h1>

      {!loaded ? (
        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Loading…</p>
      ) : configurable.length === 0 ? (
        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", lineHeight: 1.6 }}>
          No enabled harness exposes a read-only config surface. Codex is the first
          supported one — enable it under <strong>Settings → Adapters</strong> (and make
          sure <code style={{ fontFamily: "var(--font-mono)" }}>~/.codex</code> exists) to
          view its configuration here.
        </p>
      ) : (
        <>
          {configurable.length > 1 && (
            <div style={{
              display: "flex", gap: "0", marginBottom: "20px",
              background: "var(--bg-surface)", border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)", overflow: "hidden", width: "fit-content",
            }}>
              {configurable.map((a, i) => (
                <button
                  key={a.id}
                  onClick={() => setSelected(a.id)}
                  style={{
                    padding: "6px 14px", fontSize: "0.74rem", fontFamily: "var(--font-body)",
                    color: selected === a.id ? "var(--text-primary)" : "var(--text-secondary)",
                    background: selected === a.id ? "var(--bg-elevated)" : "transparent",
                    border: "none",
                    borderRight: i < configurable.length - 1 ? "1px solid var(--border-subtle)" : "none",
                    cursor: "pointer", lineHeight: 1,
                  }}
                >
                  {a.displayName}
                </button>
              ))}
            </div>
          )}
          {selected && <HarnessConfigView harnessId={selected} />}
        </>
      )}
    </div>
  );
}
