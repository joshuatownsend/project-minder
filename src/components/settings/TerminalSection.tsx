"use client";

import { useEffect, useState } from "react";
import type { MinderConfig } from "@/lib/types";

const S = {
  sectionTitle: {
    fontSize: "0.95rem", fontWeight: 600, color: "var(--text-primary)", margin: "0 0 6px 0",
  } as React.CSSProperties,
  desc: {
    fontSize: "0.78rem", color: "var(--text-secondary)", margin: "0 0 20px 0", lineHeight: 1.55,
  } as React.CSSProperties,
  card: {
    padding: "16px", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)",
    background: "var(--surface-1, transparent)", marginBottom: "16px",
  } as React.CSSProperties,
  label: { fontSize: "0.82rem", color: "var(--text-primary)", fontWeight: 500 } as React.CSSProperties,
  muted: { fontSize: "0.74rem", color: "var(--text-secondary)", lineHeight: 1.5 } as React.CSSProperties,
  input: {
    width: "100%", boxSizing: "border-box" as const, padding: "6px 10px",
    borderRadius: "var(--radius)", border: "1px solid var(--border-default)",
    background: "var(--surface-2, transparent)", color: "var(--text-primary)",
    fontSize: "0.82rem", fontFamily: "var(--font-body)",
  } as React.CSSProperties,
  btn: {
    fontSize: "0.78rem", padding: "5px 12px", borderRadius: "var(--radius)",
    border: "1px solid var(--border-default)", background: "var(--surface-2, transparent)",
    color: "var(--text-primary)", cursor: "pointer",
  } as React.CSSProperties,
};

const PLATFORM_DEFAULT = typeof window !== "undefined" && navigator.platform.startsWith("Win")
  ? "wt (Windows Terminal) or cmd"
  : typeof window !== "undefined" && navigator.platform.startsWith("Mac")
  ? "Terminal.app (osascript)"
  : "gnome-terminal, konsole, or xterm";

export function TerminalSection({
  config,
  onConfigChange,
}: {
  config: MinderConfig | null;
  onConfigChange: (patch: Partial<MinderConfig>) => Promise<void>;
}) {
  const [override, setOverride] = useState(config?.terminal ?? "");
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    setOverride(config?.terminal ?? "");
  }, [config?.terminal]);

  async function saveOverride() {
    setSaving(true);
    try {
      await onConfigChange({ terminal: override.trim() });
    } finally {
      setSaving(false);
    }
  }

  async function testLaunch() {
    setSaving(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/terminal/test", { method: "POST" });
      const d = await res.json();
      setTestResult({
        ok: res.ok && d.ok,
        message: d.ok
          ? "Terminal launched successfully."
          : `Launch failed. Fallback: ${d.fallback ?? "unknown"}`,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2 style={S.sectionTitle}>Terminal</h2>
      <p style={S.desc}>
        Configure which terminal application to use when opening sessions. Project Minder auto-detects your platform's
        default; use the override for custom terminal emulators.
      </p>

      <div style={S.card}>
        <div style={{ marginBottom: "12px" }}>
          <div style={{ ...S.label, marginBottom: "4px" }}>Auto-detected default</div>
          <div style={{ ...S.muted, fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
            {PLATFORM_DEFAULT}
          </div>
        </div>

        <div style={{ marginBottom: "16px" }}>
          <div style={{ ...S.label, marginBottom: "4px" }}>Override</div>
          <div style={S.muted}>Binary name only (e.g. <code style={{ fontFamily: "var(--font-mono)" }}>alacritty</code>). Leave blank to auto-detect.</div>
          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
            <input
              type="text"
              style={S.input}
              placeholder="Leave blank for auto-detect"
              value={override}
              onChange={(e) => setOverride(e.target.value)}
            />
            <button style={S.btn} onClick={saveOverride} disabled={saving}>
              Save
            </button>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button style={S.btn} onClick={testLaunch} disabled={saving}>
            Test launch
          </button>
          {testResult && (
            <span style={{
              fontSize: "0.78rem",
              color: testResult.ok ? "var(--success, #4ade80)" : "var(--error, #f87171)",
            }}>
              {testResult.message}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
