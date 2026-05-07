"use client";

import { useEffect, useState } from "react";
import type { MinderConfig } from "@/lib/types";
import { S } from "./styles";

interface OtelStatus {
  installed: boolean;
  endpoint: string | null;
}

const DEFAULT_ENDPOINT = "http://localhost:4100/api/otel";

export function OtelSection({
  config,
  onConfigChange,
}: {
  config: MinderConfig | null;
  onConfigChange: (patch: Partial<MinderConfig>) => Promise<void>;
}) {
  const [status, setStatus] = useState<OtelStatus | null>(null);
  const [endpoint, setEndpoint] = useState(config?.otel?.endpoint ?? DEFAULT_ENDPOINT);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/integrations/otel")
      .then((r) => r.json())
      .then((d) => setStatus(d as OtelStatus))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setEndpoint(config?.otel?.endpoint ?? DEFAULT_ENDPOINT);
  }, [config?.otel?.endpoint]);

  async function callApi(action: "install" | "remove"): Promise<OtelStatus> {
    const res = await fetch("/api/integrations/otel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, endpoint: action === "install" ? endpoint : undefined }),
    });
    const data = (await res.json()) as OtelStatus & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `${action} failed`);
    return data;
  }

  async function handleInstall() {
    setBusy(true); setMsg(null);
    try {
      const next = await callApi("install");
      await onConfigChange({ otel: { endpoint } });
      setStatus(next);
      setMsg({ text: "OTEL env vars written to ~/.claude/settings.json. Restart Claude Code for them to take effect.", ok: true });
    } catch (err) {
      setMsg({ text: (err as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setBusy(true); setMsg(null);
    try {
      const next = await callApi("remove");
      setStatus(next);
      setMsg({ text: "OTEL env vars removed.", ok: true });
    } catch (err) {
      setMsg({ text: (err as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  const installedElsewhere =
    status?.installed && status.endpoint !== null && status.endpoint !== endpoint;
  const alreadyInstalled = !!status?.installed && !installedElsewhere;
  const installLabel = busy ? "Working…" : installedElsewhere ? "Reinstall" : "Install";

  return (
    <div style={S.card}>
      <div style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--text-primary)", marginBottom: "12px" }}>
        OpenTelemetry (OTEL)
      </div>

      <div style={{ ...S.muted, marginBottom: "16px" }}>
        Receive real-time tool events and cost metrics from Claude Code via the OTEL pipeline.
        Enables edit-acceptance tracking and per-tool latency dashboards in a future update.
      </div>

      {/* Status indicator */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
        <span style={{
          display: "inline-block", width: "8px", height: "8px", borderRadius: "50%",
          background: status?.installed ? "var(--status-active-text)" : "var(--border-default)",
          flexShrink: 0,
        }} />
        <span style={S.label}>
          {status === null
            ? "Checking…"
            : status.installed
            ? `Configured — receiving at ${status.endpoint}`
            : "Not configured"}
        </span>
      </div>

      {installedElsewhere && (
        <div style={{
          fontSize: "0.74rem", color: "var(--accent)", background: "var(--accent-bg)",
          border: "1px solid var(--accent-border)", borderRadius: "var(--radius)",
          padding: "8px 12px", marginBottom: "12px",
        }}>
          OTEL is configured with a different endpoint ({status!.endpoint}). Click Install to update.
        </div>
      )}

      {/* Endpoint field */}
      <div style={{ marginBottom: "16px" }}>
        <div style={{ ...S.label, marginBottom: "4px" }}>Receiver endpoint</div>
        <input
          type="text"
          style={S.input}
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder={DEFAULT_ENDPOINT}
        />
        <div style={{ ...S.muted, marginTop: "4px" }}>
          Claude Code appends <code style={{ fontFamily: "var(--font-mono)" }}>/v1/logs</code> and{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>/v1/metrics</code> to this base URL.
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" }}>
        <button
          style={{
            ...S.btn,
            background: "var(--info)", color: "#fff", borderColor: "var(--info)",
            opacity: alreadyInstalled || busy ? 0.4 : 1,
          }}
          disabled={alreadyInstalled || busy}
          onClick={handleInstall}
        >
          {installLabel}
        </button>
        <button
          style={{
            ...S.btn,
            color: "var(--status-error-text)", borderColor: "var(--status-error-border)",
            opacity: (!status?.installed || busy) ? 0.4 : 1,
          }}
          disabled={!status?.installed || busy}
          onClick={handleRemove}
        >
          Remove
        </button>
      </div>

      {msg && (
        <div style={{
          fontSize: "0.74rem", marginBottom: "12px",
          color: msg.ok ? "var(--status-active-text)" : "var(--status-error-text)",
        }}>
          {msg.text}
        </div>
      )}

      {/* Setup note */}
      <div style={{
        padding: "10px 12px", borderRadius: "var(--radius)",
        background: "var(--surface-2, transparent)", fontSize: "0.74rem",
        color: "var(--text-muted)", lineHeight: 1.6,
      }}>
        <strong style={{ color: "var(--text-secondary)" }}>Setup:</strong>{" "}
        Click Install to write four env vars into{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>~/.claude/settings.json</code>:
        {" "}<code style={{ fontFamily: "var(--font-mono)" }}>CLAUDE_CODE_ENABLE_TELEMETRY=1</code>,
        {" "}<code style={{ fontFamily: "var(--font-mono)" }}>OTEL_EXPORTER_OTLP_ENDPOINT</code>,
        {" "}<code style={{ fontFamily: "var(--font-mono)" }}>OTEL_EXPORTER_OTLP_PROTOCOL=http/json</code>, and
        {" "}<code style={{ fontFamily: "var(--font-mono)" }}>OTEL_LOG_TOOL_DETAILS=1</code>.{" "}
        Restart Claude Code for the vars to take effect. All telemetry data stays local.
      </div>
    </div>
  );
}
