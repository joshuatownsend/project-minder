"use client";

import { useEffect, useState } from "react";
import type { MinderConfig } from "@/lib/types";
import { DEFAULT_PORT } from "@/lib/boundPort";
import { S } from "./styles";
import { useHelp } from "@/components/HelpProvider";

function currentPort(): string {
  if (typeof window === "undefined") return "unknown";
  return window.location.port || (window.location.protocol === "https:" ? "443" : "80");
}

export function ServerPortSection({
  config,
  onConfigChange,
}: {
  config: MinderConfig | null;
  onConfigChange: (patch: Partial<MinderConfig>) => Promise<void>;
}) {
  const { openHelp } = useHelp();
  const [running, setRunning] = useState("unknown");
  const [value, setValue] = useState(String(config?.port ?? DEFAULT_PORT));
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    setRunning(currentPort());
  }, []);

  useEffect(() => {
    setValue(String(config?.port ?? DEFAULT_PORT));
  }, [config?.port]);

  const parsed = Number(value.trim());
  const valid = value.trim() !== "" && Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535;

  async function save() {
    if (!valid) return;
    setSaving(true);
    setMsg(null);
    try {
      await onConfigChange({ port: parsed });
      setMsg({ text: "Saved. This is a stored preference only — see below to actually apply it.", ok: true });
    } catch {
      // patchConfig already surfaced a toast; nothing more to show here.
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    setResetting(true);
    setMsg(null);
    try {
      // `null` is the wire PATCH's clear-signal, distinct from the stored
      // config shape where `port` is `number | undefined` and never `null`.
      // The cast lives here at the call site rather than on `MinderConfig`.
      await onConfigChange({ port: null } as unknown as Partial<MinderConfig>);
      setValue(String(DEFAULT_PORT));
      setMsg({ text: "Reset to default. This is a stored preference only — see below to actually apply it.", ok: true });
    } catch {
      // patchConfig already surfaced a toast; nothing more to show here.
    } finally {
      setResetting(false);
    }
  }

  const effectivePort = config?.port ?? DEFAULT_PORT;
  const canReset = config?.port !== undefined && config.port !== DEFAULT_PORT;

  return (
    <section>
      <h2 style={S.sectionTitle}>Server Port</h2>
      <p style={S.desc}>
        Project Minder defaults to port 4100. On Windows, that port can land inside a range
        Hyper-V, WSL2, or Docker Desktop reserve for their own networking (WinNAT) — not a
        conflicting app, an OS-level block that can appear after a reboot. If you hit that,
        record the port you want here, then apply it using the instructions below for
        however you currently run Project Minder.
      </p>

      <div style={S.card}>
        <div style={{ marginBottom: "12px" }}>
          <div style={{ ...S.label, marginBottom: "4px" }}>Currently running on</div>
          <div style={{ ...S.muted, fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
            localhost:{running}
          </div>
        </div>

        <div style={{ marginBottom: "16px" }}>
          <div style={{ ...S.label, marginBottom: "4px" }}>Configured port (applies on next restart)</div>
          <div style={S.muted}>Integer between 1024 and 65535.</div>
          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
            <input
              type="number"
              style={S.input}
              placeholder={String(DEFAULT_PORT)}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              min={1024}
              max={65535}
            />
            <button style={S.btn} onClick={save} disabled={saving || !valid}>
              Save
            </button>
            {canReset && (
              <button
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  color: "var(--info)",
                  textDecoration: "underline",
                  fontSize: "0.78rem",
                  alignSelf: "center",
                }}
                onClick={resetToDefault}
                disabled={resetting}
              >
                Reset to default
              </button>
            )}
          </div>
          {!valid && value.trim() !== "" && (
            <div style={{ ...S.muted, marginTop: "6px", color: "var(--status-error-text)" }}>
              Enter an integer between 1024 and 65535.
            </div>
          )}
          {msg && (
            <div
              style={{
                fontSize: "0.74rem",
                marginTop: "8px",
                color: msg.ok ? "var(--status-active-text)" : "var(--status-error-text)",
              }}
            >
              {msg.text}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "10px 12px",
            borderRadius: "var(--radius)",
            background: "var(--bg-elevated)",
            fontSize: "0.74rem",
            color: "var(--text-muted)",
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: "var(--text-secondary)" }}>Saving does not restart or move anything.</strong>{" "}
          Apply <code style={{ fontFamily: "var(--font-mono)" }}>{effectivePort}</code> using whichever run
          mode you use:
          <ul style={{ margin: "8px 0 0 0", paddingLeft: "18px" }}>
            <li style={{ marginBottom: "6px" }}>
              <strong style={{ color: "var(--text-secondary)" }}>Dev/start (CLI):</strong> pass{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>-- -p {effectivePort}</code> to{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>pnpm dev</code> /{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>pnpm start</code>, or edit the{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>-p 4100</code> in{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>package.json</code> directly.
            </li>
            <li style={{ marginBottom: "6px" }}>
              <strong style={{ color: "var(--text-secondary)" }}>Windows Service:</strong> run{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>pnpm service:uninstall</code> if already
              installed, then (PowerShell){" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>
                $env:MINDER_PORT={effectivePort}; pnpm service:install
              </code>
              {" "}— cmd.exe users:{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>
                set MINDER_PORT={effectivePort} &amp;&amp; pnpm service:install
              </code>
              .
            </li>
            <li>
              <strong style={{ color: "var(--text-secondary)" }}>Tray app:</strong> set{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>MINDER_TRAY_PORT={effectivePort}</code> in your
              environment before launching.
            </li>
          </ul>
          <div style={{ marginTop: "8px" }}>
            See the{" "}
            <button
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: "var(--info)",
                textDecoration: "underline",
                fontSize: "inherit",
              }}
              onClick={() => openHelp("tray-app")}
            >
              Tray App help doc
            </button>{" "}
            for why Windows sometimes reserves this port (Hyper-V/WSL2/Docker WinNAT) and how to check
            and fix it.
          </div>
        </div>
      </div>
    </section>
  );
}
