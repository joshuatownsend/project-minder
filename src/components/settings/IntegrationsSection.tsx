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

export function IntegrationsSection({
  config,
  onConfigChange,
}: {
  config: MinderConfig | null;
  onConfigChange: (patch: Partial<MinderConfig>) => Promise<void>;
}) {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState(config?.telegram?.chatId ?? "");
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    fetch("/api/secrets/telegram")
      .then((r) => r.json())
      .then((d) => setTokenConfigured(d.configured && d.configured !== false))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setChatId(config?.telegram?.chatId ?? "");
  }, [config?.telegram?.chatId]);

  async function saveToken() {
    if (!botToken.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/secrets/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim() }),
      });
      if (res.ok) { setTokenConfigured(true); setBotToken(""); }
    } finally {
      setSaving(false);
    }
  }

  async function saveChatId() {
    if (!chatId.trim()) return;
    setSaving(true);
    try {
      await onConfigChange({ telegram: { chatId: chatId.trim() } });
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setSaving(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/notifications/telegram/test", { method: "POST" });
      const d = await res.json();
      setTestResult({ ok: res.ok, message: res.ok ? "Message sent to Telegram." : (d.error ?? res.statusText) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2 style={S.sectionTitle}>Integrations</h2>
      <p style={S.desc}>Connect external notification channels. Telegram bot bridge (Wave 7). OTEL and others coming in Wave 8.</p>

      <div style={S.card}>
        <div style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--text-primary)", marginBottom: "12px" }}>
          Telegram
        </div>

        <div style={{ marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <div style={S.label}>Bot token</div>
            {tokenConfigured && (
              <span style={{
                fontSize: "0.62rem", fontFamily: "var(--font-mono)", padding: "1px 6px",
                borderRadius: "3px", border: "1px solid var(--border-subtle)", color: "var(--text-muted)",
              }}>
                configured
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <input
              type="password"
              style={S.input}
              placeholder={tokenConfigured ? "Enter new token to replace" : "Bot token from @BotFather"}
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
            <button style={S.btn} onClick={saveToken} disabled={saving || !botToken.trim()}>
              Save
            </button>
          </div>
        </div>

        <div style={{ marginBottom: "16px" }}>
          <div style={{ ...S.label, marginBottom: "4px" }}>Chat ID</div>
          <div style={{ display: "flex", gap: "8px" }}>
            <input
              type="text"
              style={S.input}
              placeholder="Your Telegram chat ID (numeric)"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
            />
            <button style={S.btn} onClick={saveChatId} disabled={saving || !chatId.trim()}>
              Save
            </button>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button
            style={S.btn}
            onClick={testConnection}
            disabled={saving || !tokenConfigured || !config?.telegram?.chatId}
          >
            Test connection
          </button>
          {testResult && (
            <span style={{ fontSize: "0.78rem", color: testResult.ok ? "var(--success, #4ade80)" : "var(--error, #f87171)" }}>
              {testResult.message}
            </span>
          )}
        </div>

        <div style={{
          marginTop: "16px", padding: "10px 12px", borderRadius: "var(--radius)",
          background: "var(--surface-2, transparent)", fontSize: "0.74rem", color: "var(--text-muted)", lineHeight: 1.6,
        }}>
          <strong style={{ color: "var(--text-secondary)" }}>Setup:</strong>{" "}
          Create a bot with @BotFather and copy the token. Send /start to your bot, then visit{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>
            https://api.telegram.org/bot&lt;token&gt;/getUpdates
          </code>{" "}
          to find your chat ID.
        </div>
      </div>
    </section>
  );
}
