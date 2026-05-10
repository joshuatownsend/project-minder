"use client";

import { useState, useCallback } from "react";
import type { MinderConfig } from "@/lib/types";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_LABELS,
  isShortcutActionId,
  isValidCombo,
  parseCombo,
  type ShortcutActionId,
} from "@/lib/keyboardShortcuts";
import { S } from "./styles";

type CaptureState = { actionId: ShortcutActionId; current: string } | null;

function comboDisplay(combo: string): string {
  const { mods, key } = parseCombo(combo);
  const parts: string[] = [...mods].sort().map((m) => {
    if (m === "Meta") return "⌘";
    if (m === "Ctrl") return "Ctrl";
    if (m === "Alt") return "Alt";
    if (m === "Shift") return "⇧";
    return m;
  });
  parts.push(key === key.toLowerCase() ? key.toUpperCase() : key);
  return parts.join("+");
}

export function AppearanceSection({
  config,
  onConfigChange,
}: {
  config: MinderConfig | null;
  onConfigChange: (patch: Partial<MinderConfig>) => Promise<void>;
}) {
  const [capture, setCapture] = useState<CaptureState>(null);
  const [capturedCombo, setCapturedCombo] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const overrides = config?.keyboardShortcuts ?? {};
  const effectiveShortcuts = {
    ...DEFAULT_SHORTCUTS,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([k]) => isShortcutActionId(k))
    ),
  } as Record<ShortcutActionId, string>;

  const actionIds = Object.keys(DEFAULT_SHORTCUTS) as ShortcutActionId[];

  const startCapture = useCallback((actionId: ShortcutActionId) => {
    setCapture({ actionId, current: effectiveShortcuts[actionId] });
    setCapturedCombo(null);
    setSaveError(null);
  }, [effectiveShortcuts]);

  const cancelCapture = useCallback(() => {
    setCapture(null);
    setCapturedCombo(null);
    setSaveError(null);
  }, []);

  const handleCaptureKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { cancelCapture(); return; }
    if (e.key === "Tab" || e.key === "Enter") return;

    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.metaKey) mods.push("Meta");
    if (e.altKey) mods.push("Alt");
    // Only add Shift for letter keys — for symbols (?, !, @, etc.) Shift is already
    // baked into e.key (e.g. Shift+/ → e.key === "?"), so omitting it keeps combos
    // consistent with isShortcutMatch's matching logic.
    if (e.shiftKey && /^[a-zA-Z]$/.test(e.key)) mods.push("Shift");

    const key = e.key;
    if (["Control", "Meta", "Alt", "Shift"].includes(key)) return;

    const combo = mods.length > 0 ? `${mods.join("+")}+${key}` : key;
    if (isValidCombo(combo)) {
      setCapturedCombo(combo);
      setSaveError(null);
    }
  }, [cancelCapture]);

  async function saveCapture() {
    if (!capture || !capturedCombo) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onConfigChange({
        keyboardShortcuts: {
          ...overrides,
          [capture.actionId]: capturedCombo,
        },
      });
      setCapture(null);
      setCapturedCombo(null);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefaults() {
    setSaving(true);
    setSaveError(null);
    try {
      await onConfigChange({ keyboardShortcuts: {} });
      setCapture(null);
      setCapturedCombo(null);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const hasOverrides = Object.keys(overrides).some((k) => isShortcutActionId(k));

  return (
    <section>
      <h2 style={S.sectionTitle}>Appearance</h2>
      <p style={S.desc}>
        Customize keyboard shortcuts. Click Edit on any action, then press the key combination you want to assign.
      </p>

      <div style={S.card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <div style={S.label}>Keyboard shortcuts</div>
          {hasOverrides && (
            <button style={{ ...S.btn, fontSize: "0.72rem" }} onClick={resetToDefaults} disabled={saving}>
              Reset to defaults
            </button>
          )}
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {actionIds.map((id) => {
              const isCapturing = capture?.actionId === id;
              const isCustom = isShortcutActionId(id) && id in overrides;
              const combo = effectiveShortcuts[id];

              return (
                <tr key={id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                  <td style={{ padding: "8px 0", width: "55%", ...S.label, fontWeight: 400 }}>
                    {SHORTCUT_LABELS[id]}
                  </td>
                  <td style={{ padding: "8px 0", width: "30%" }}>
                    {isCapturing ? (
                      <div
                        tabIndex={0}
                        onKeyDown={handleCaptureKeyDown}
                        autoFocus
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "3px 8px",
                          border: "1px solid var(--info)",
                          borderRadius: "var(--radius)",
                          fontSize: "0.72rem",
                          fontFamily: "var(--font-mono)",
                          background: "var(--info-bg)",
                          color: "var(--info)",
                          cursor: "text",
                          outline: "none",
                          minWidth: "120px",
                        }}
                      >
                        {capturedCombo ? comboDisplay(capturedCombo) : "Press a key…"}
                      </div>
                    ) : (
                      <span style={{
                        ...S.badge,
                        color: isCustom ? "var(--text-primary)" : "var(--text-muted)",
                      }}>
                        {comboDisplay(combo)}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "8px 0", width: "15%", textAlign: "right" }}>
                    {isCapturing ? (
                      <span style={{ display: "inline-flex", gap: "4px" }}>
                        <button
                          style={{ ...S.btn, fontSize: "0.72rem" }}
                          onClick={saveCapture}
                          disabled={saving || !capturedCombo}
                        >
                          Save
                        </button>
                        <button
                          style={{ ...S.btn, fontSize: "0.72rem" }}
                          onClick={cancelCapture}
                          disabled={saving}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        style={{ ...S.btn, fontSize: "0.72rem" }}
                        onClick={() => startCapture(id)}
                        disabled={capture !== null}
                      >
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {saveError && (
          <p style={{ marginTop: "8px", fontSize: "0.74rem", color: "var(--error, #f87171)" }}>
            {saveError}
          </p>
        )}
      </div>
    </section>
  );
}
