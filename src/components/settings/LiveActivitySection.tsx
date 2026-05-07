"use client";

import { useEffect, useState } from "react";
import type { MinderConfig } from "@/lib/types";
import { getFlag } from "@/lib/featureFlags";
import { S } from "./styles";
import { Toggle } from "./Toggle";

interface InstallStatus {
  installed: boolean;
  hookUrl: string | null;
  eventsRegistered: string[];
}

export function LiveActivitySection({
  config,
  onConfigChange,
}: {
  config: MinderConfig | null;
  onConfigChange: (patch: Partial<MinderConfig>) => Promise<void>;
}) {
  const [status, setStatus] = useState<InstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const flagEnabled = getFlag(config?.featureFlags, "liveActivity", false);
  const awaitingPrefs = config?.notificationPrefs?.events?.["awaiting-permission"] ?? {};

  useEffect(() => {
    fetch("/api/live-activity/install")
      .then((r) => r.json())
      .then((d) => setStatus(d as InstallStatus))
      .catch(() => {});
  }, []);

  const currentOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const needsReinstall =
    status?.installed && status.hookUrl !== null && status.hookUrl !== `${currentOrigin}/api/hooks`;

  async function callApi(method: "POST" | "DELETE", body?: object): Promise<InstallStatus> {
    const res = await fetch("/api/live-activity/install", {
      method,
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json()) as InstallStatus & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `${method} failed`);
    return data;
  }

  async function handleInstall() {
    setBusy(true); setMsg(null);
    try {
      setStatus(await callApi("POST", { hookUrl: `${currentOrigin}/api/hooks` }));
      setMsg({ text: "Hooks installed successfully.", ok: true });
    } catch (err) {
      setMsg({ text: (err as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setBusy(true); setMsg(null);
    try {
      setStatus(await callApi("DELETE"));
      setMsg({ text: "Hooks removed.", ok: true });
    } catch (err) {
      setMsg({ text: (err as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function handleReinstall() {
    setBusy(true); setMsg(null);
    try {
      setStatus(await callApi("DELETE"));
      setStatus(await callApi("POST", { hookUrl: `${currentOrigin}/api/hooks` }));
      setMsg({ text: "Hooks reinstalled successfully.", ok: true });
    } catch (err) {
      setMsg({ text: (err as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function handleFlagToggle(val: boolean) {
    await onConfigChange({ featureFlags: { ...config?.featureFlags, liveActivity: val } });
  }

  async function handleAwaitingPrefToggle(channel: "push" | "telegram" | "os", val: boolean) {
    await onConfigChange({
      notificationPrefs: {
        ...config?.notificationPrefs,
        events: {
          ...config?.notificationPrefs?.events,
          "awaiting-permission": { ...awaitingPrefs, [channel]: val },
        },
      },
    });
  }

  return (
    <div>
      <p style={S.desc}>
        Receive real-time lifecycle events from Claude Code. When enabled and hooks are installed,
        project cards light up while Claude is active, and you get an alert when Claude needs permission.
      </p>

      {/* Enable toggle */}
      <div style={{ ...S.card, marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
          <div>
            <div style={S.label}>Enable live activity</div>
            <div style={S.muted}>Activates the hook receiver. Hooks must also be installed below.</div>
          </div>
          <Toggle value={flagEnabled} onChange={handleFlagToggle} label="Enable live activity" />
        </div>
      </div>

      {/* Install status + actions */}
      <div style={{ ...S.card, marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
          <span style={{
            display: "inline-block", width: "8px", height: "8px", borderRadius: "50%",
            background: status?.installed ? "var(--status-active-text)" : "var(--border-default)",
            flexShrink: 0,
          }} />
          <span style={S.label}>
            {status === null
              ? "Checking…"
              : status.installed
              ? `Hooks installed (${status.eventsRegistered.length} events)`
              : "Hooks not installed"}
          </span>
        </div>

        {status?.installed && status.hookUrl && (
          <div style={{ ...S.muted, marginBottom: "12px", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
            {status.hookUrl}
          </div>
        )}

        {needsReinstall && (
          <div style={{
            fontSize: "0.74rem", color: "var(--accent)", background: "var(--accent-bg)",
            border: "1px solid var(--accent-border)", borderRadius: "var(--radius)",
            padding: "8px 12px", marginBottom: "12px",
          }}>
            Hooks are registered to a different origin. Click Reinstall to update.
          </div>
        )}

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button
            style={{ ...S.btn, background: "var(--info)", color: "#fff", borderColor: "var(--info)", opacity: (!flagEnabled || status?.installed || busy) ? 0.4 : 1 }}
            disabled={!flagEnabled || status?.installed || busy}
            onClick={handleInstall}
          >
            {busy ? "Working…" : "Install"}
          </button>

          {needsReinstall && (
            <button
              style={{ ...S.btn, background: "var(--info)", color: "#fff", borderColor: "var(--info)", opacity: busy ? 0.4 : 1 }}
              disabled={busy}
              onClick={handleReinstall}
            >
              Reinstall
            </button>
          )}

          <button
            style={{ ...S.btn, color: "var(--status-error-text)", borderColor: "var(--status-error-border)", opacity: (!status?.installed || busy) ? 0.4 : 1 }}
            disabled={!status?.installed || busy}
            onClick={handleRemove}
          >
            Remove
          </button>
        </div>

        {msg && (
          <div style={{
            marginTop: "10px", fontSize: "0.74rem",
            color: msg.ok ? "var(--status-active-text)" : "var(--status-error-text)",
          }}>
            {msg.text}
          </div>
        )}

        <div style={{ ...S.muted, marginTop: "12px" }}>
          Project Minder must be reachable at the registered URL while Claude Code is running.
          If you change ports, click Reinstall.
        </div>
      </div>

      {/* Awaiting-permission notification prefs */}
      <div style={{ ...S.card }}>
        <div style={{ ...S.label, marginBottom: "4px" }}>Awaiting-permission alerts</div>
        <div style={{ ...S.muted, marginBottom: "12px" }}>
          Get notified when Claude Code is waiting for your input or approval.
        </div>

        {(["os", "push", "telegram"] as const).map((channel) => (
          <div key={channel} style={{ ...S.row, marginBottom: "4px" }}>
            <span style={S.label}>{channel === "os" ? "Browser notification" : channel === "push" ? "Push (mobile)" : "Telegram"}</span>
            <Toggle
              value={!!(awaitingPrefs as Record<string, boolean | undefined>)[channel]}
              onChange={(v) => handleAwaitingPrefToggle(channel, v)}
              label={`Enable ${channel} for awaiting-permission`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
