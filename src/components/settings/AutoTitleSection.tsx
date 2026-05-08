"use client";

import { useEffect, useState } from "react";
import type { MinderConfig } from "@/lib/types";
import { S } from "./styles";
import { DEFAULT_ENDPOINT, DEFAULT_MODEL } from "@/lib/llm/defaults";

export function AutoTitleSection({
  config,
  onConfigChange,
}: {
  config: MinderConfig | null;
  onConfigChange: (patch: Partial<MinderConfig>) => Promise<void>;
}) {
  const [endpoint, setEndpoint] = useState(config?.autoTitle?.endpoint ?? "");
  const [model, setModel] = useState(config?.autoTitle?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; title?: string; error?: string } | null>(null);

  useEffect(() => {
    fetch("/api/secrets/llm")
      .then((r) => r.json())
      .then((d) => setKeyConfigured(!!d.configured))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setEndpoint(config?.autoTitle?.endpoint ?? "");
    setModel(config?.autoTitle?.model ?? "");
  }, [config?.autoTitle]);

  async function saveSettings() {
    setSaving(true);
    try {
      const patch: Partial<MinderConfig> = {
        autoTitle: {
          endpoint: endpoint.trim() || DEFAULT_ENDPOINT,
          model: model.trim() || DEFAULT_MODEL,
        },
      };
      await onConfigChange(patch);
      if (apiKey.trim()) {
        const res = await fetch("/api/secrets/llm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: apiKey.trim() }),
        });
        if (res.ok) { setKeyConfigured(true); setApiKey(""); }
      }
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setSaving(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/llm/test", { method: "POST" });
      const d = await res.json();
      if (res.ok) {
        setTestResult({ ok: true, title: d.title });
      } else {
        setTestResult({ ok: false, error: d.error ?? res.statusText });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2 style={S.sectionTitle}>Auto-title</h2>
      <p style={S.desc}>
        Generate concise 4-8 word titles for sessions using an LLM. Titles are stored in the database and shown
        instead of the raw first prompt. Uses Anthropic API by default; any OpenAI-compatible endpoint works too.
      </p>

      <div style={S.card}>
        <div style={{ marginBottom: "12px" }}>
          <div style={{ ...S.label, marginBottom: "4px" }}>API endpoint</div>
          <input
            type="url"
            style={S.input}
            placeholder={DEFAULT_ENDPOINT}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
          <div style={{ ...S.muted, marginTop: "4px" }}>OpenAI-compatible endpoints also work (set to /chat/completions).</div>
        </div>

        <div style={{ marginBottom: "12px" }}>
          <div style={{ ...S.label, marginBottom: "4px" }}>Model</div>
          <input
            type="text"
            style={S.input}
            placeholder={DEFAULT_MODEL}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>

        <div style={{ marginBottom: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <div style={S.label}>API key</div>
            {keyConfigured && (
              <span style={{
                fontSize: "0.62rem", fontFamily: "var(--font-mono)", padding: "1px 6px",
                borderRadius: "3px", border: "1px solid var(--border-subtle)", color: "var(--text-muted)",
              }}>
                configured
              </span>
            )}
          </div>
          <input
            type="password"
            style={S.input}
            placeholder={keyConfigured ? "Enter new key to replace" : "sk-ant-… or your API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <div style={{ ...S.muted, marginTop: "4px" }}>
            Stored in ~/.minder/secrets.json (not in config). Never sent to the browser.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button style={S.btn} onClick={saveSettings} disabled={saving}>
            Save settings
          </button>
          <button
            style={S.btn}
            onClick={runTest}
            disabled={saving || !keyConfigured}
            title={!keyConfigured ? "Configure API key first" : ""}
          >
            Test
          </button>
        </div>

        {testResult && (
          <div style={{
            marginTop: "12px", padding: "10px 12px", borderRadius: "var(--radius)",
            background: "var(--bg-elevated)",
            fontSize: "0.78rem",
            color: testResult.ok ? "var(--text-primary)" : "var(--error, #f87171)",
          }}>
            {testResult.ok
              ? <><strong>Generated title:</strong> {testResult.title}</>
              : <><strong>Error:</strong> {testResult.error}</>
            }
          </div>
        )}
      </div>
    </section>
  );
}
