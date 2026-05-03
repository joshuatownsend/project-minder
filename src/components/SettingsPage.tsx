"use client";

import { useEffect, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import type { FeatureFlagKey, MinderConfig } from "@/lib/types";
import { FEATURE_FLAG_META, getFlag } from "@/lib/featureFlags";
import { useToast } from "@/components/ToastProvider";

// Hoisted so each Settings render doesn't re-filter the static metadata.
const FLAG_GROUPS = {
  passive: FEATURE_FLAG_META.filter((f) => f.group === "passive"),
  active: FEATURE_FLAG_META.filter((f) => f.group === "active"),
};

type SectionKey =
  | "features"
  | "appearance"
  | "cost"
  | "notifications"
  | "integrations"
  | "data"
  | "terminal"
  | "auto-title";

interface SectionDef {
  key: SectionKey;
  label: string;
  /** Wave number where this section's controls actually ship. Wave 1
   *  ships only "features" — the rest render a "Coming in wave N" hint
   *  so the IA is final on day one. */
  shipsInWave: number;
  description: string;
}

const SECTIONS: SectionDef[] = [
  { key: "features",      label: "Features",      shipsInWave: 1,  description: "Subsystem on/off toggles." },
  { key: "appearance",    label: "Appearance",    shipsInWave: 12, description: "View mode, theme, keyboard shortcuts." },
  { key: "cost",          label: "Cost",          shipsInWave: 8,  description: "Currency, pricing rules, schedule mode for burndown." },
  { key: "notifications", label: "Notifications", shipsInWave: 7,  description: "Push and Telegram event toggles." },
  { key: "integrations",  label: "Integrations",  shipsInWave: 8,  description: "OTEL, Anthropic OAuth, currency API status." },
  { key: "data",          label: "Data & Privacy", shipsInWave: 7, description: "History retention, distillation defaults, export shortcuts." },
  { key: "terminal",      label: "Terminal",      shipsInWave: 7,  description: "Preferred terminal application for resume." },
  { key: "auto-title",    label: "Auto-title",    shipsInWave: 7,  description: "LLM endpoint for session-title generation." },
];

export function SettingsPage() {
  const { showToast } = useToast();
  const [active, setActive] = useState<SectionKey>("features");
  const [config, setConfig] = useState<MinderConfig | null>(null);
  const [saving, setSaving] = useState<FeatureFlagKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: MinderConfig) => {
        if (!cancelled) setConfig(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          showToast("Couldn't load settings", e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  async function toggleFlag(key: FeatureFlagKey, next: boolean) {
    if (!config) return;
    setSaving(key);
    // Capture only THIS key's prior value (undefined = unset / default).
    // Reverting just this key on failure preserves any other in-flight
    // toggles — capturing the whole featureFlags map and restoring it
    // would clobber concurrent successful saves of other keys.
    const priorValue = config.featureFlags?.[key];
    setConfig((curr) =>
      curr ? { ...curr, featureFlags: { ...(curr.featureFlags ?? {}), [key]: next } } : curr
    );
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureFlags: { [key]: next } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (e: unknown) {
      setConfig((curr) => {
        if (!curr) return curr;
        const flags = { ...(curr.featureFlags ?? {}) };
        if (priorValue === undefined) {
          delete flags[key];
        } else {
          flags[key] = priorValue;
        }
        return { ...curr, featureFlags: flags };
      });
      showToast("Couldn't save setting", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  }

  const activeSection = SECTIONS.find((s) => s.key === active);

  return (
    <div style={{ display: "flex", gap: "24px", padding: "20px 0", minHeight: "60vh" }}>
      <aside style={{ width: "180px", flexShrink: 0 }}>
        <header style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
          <SettingsIcon style={{ width: "13px", height: "13px", color: "var(--text-muted)" }} />
          <h1
            style={{
              fontSize: "0.7rem",
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-secondary)",
              fontFamily: "var(--font-body)",
              margin: 0,
            }}
          >
            Settings
          </h1>
        </header>
        <nav style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
          {SECTIONS.map((s) => {
            const isActive = active === s.key;
            return (
              <button
                key={s.key}
                onClick={() => setActive(s.key)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: "6px",
                  padding: "6px 10px",
                  textAlign: "left",
                  background: isActive ? "var(--info-bg)" : "transparent",
                  color: isActive ? "var(--info)" : "var(--text-secondary)",
                  border: "none",
                  borderRadius: "var(--radius)",
                  fontSize: "0.78rem",
                  fontFamily: "var(--font-body)",
                  fontWeight: isActive ? 500 : 400,
                  cursor: "pointer",
                }}
              >
                <span>{s.label}</span>
                {s.shipsInWave > 1 && (
                  <span
                    title={`Ships in wave ${s.shipsInWave}`}
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.6rem",
                      color: "var(--text-muted)",
                    }}
                  >
                    W{s.shipsInWave}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </aside>

      <main style={{ flex: 1, minWidth: 0 }}>
        {active === "features" && (
          <FeaturesSection config={config} saving={saving} onToggle={toggleFlag} />
        )}
        {active !== "features" && activeSection && (
          <PlaceholderSection
            label={activeSection.label}
            wave={activeSection.shipsInWave}
            description={activeSection.description}
          />
        )}
      </main>
    </div>
  );
}

function FeaturesSection(props: {
  config: MinderConfig | null;
  saving: FeatureFlagKey | null;
  onToggle: (key: FeatureFlagKey, next: boolean) => void;
}) {
  const { config, saving, onToggle } = props;
  const flags = config?.featureFlags;

  return (
    <section>
      <h2
        style={{
          fontSize: "0.95rem",
          fontWeight: 600,
          color: "var(--text-primary)",
          margin: "0 0 6px 0",
        }}
      >
        Features
      </h2>
      <p style={{ fontSize: "0.78rem", color: "var(--text-secondary)", margin: "0 0 20px 0", lineHeight: 1.55 }}>
        Toggle subsystems on or off. Scanner flags take effect on the next scan;
        watcher and ingest flags require a server restart for now.
      </p>

      <FlagGroup
        title="Passive observation"
        subtitle="Filesystem reads — cheap, idempotent."
        flags={FLAG_GROUPS.passive}
        currentFlags={flags}
        saving={saving}
        disabled={config === null}
        onToggle={onToggle}
      />
      <FlagGroup
        title="Active subsystems"
        subtitle="Background work — watchers, ingest, indexers."
        flags={FLAG_GROUPS.active}
        currentFlags={flags}
        saving={saving}
        disabled={config === null}
        onToggle={onToggle}
      />
    </section>
  );
}

function FlagGroup(props: {
  title: string;
  subtitle: string;
  flags: typeof FEATURE_FLAG_META;
  currentFlags: MinderConfig["featureFlags"];
  saving: FeatureFlagKey | null;
  disabled: boolean;
  onToggle: (key: FeatureFlagKey, next: boolean) => void;
}) {
  const { title, subtitle, flags, currentFlags, saving, disabled, onToggle } = props;
  return (
    <div style={{ marginBottom: "28px" }}>
      <div style={{ marginBottom: "10px" }}>
        <div
          style={{
            fontSize: "0.62rem",
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "2px" }}>
          {subtitle}
        </div>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "1px" }}>
        {flags.map((f) => {
          const value = getFlag(currentFlags, f.key);
          const isSaving = saving === f.key;
          return (
            <li
              key={f.key}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                alignItems: "center",
                gap: "12px",
                padding: "10px 12px",
                borderRadius: "var(--radius)",
                background: "var(--surface-1, transparent)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "0.82rem", color: "var(--text-primary)", fontWeight: 500 }}>
                    {f.label}
                  </span>
                  {!f.wired && (
                    <span
                      title="The toggle persists, but no consumer reads it yet. A future wave will wire it."
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.6rem",
                        color: "var(--text-muted)",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: "3px",
                        padding: "0 4px",
                      }}
                    >
                      not wired
                    </span>
                  )}
                </div>
                <div style={{ fontSize: "0.74rem", color: "var(--text-secondary)", marginTop: "2px", lineHeight: 1.5 }}>
                  {f.description}
                </div>
              </div>
              <Toggle
                value={value}
                disabled={disabled || isSaving}
                onChange={(v) => onToggle(f.key, v)}
                ariaLabel={f.label}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Toggle(props: {
  value: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
}) {
  const { value, disabled, onChange, ariaLabel } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!value)}
      style={{
        width: "34px",
        height: "18px",
        borderRadius: "9999px",
        position: "relative",
        background: value ? "var(--info)" : "var(--border-default)",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.15s",
        border: "none",
        padding: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          top: "2px",
          left: value ? "18px" : "2px",
          width: "14px",
          height: "14px",
          borderRadius: "50%",
          background: "var(--bg-primary, #fff)",
          transition: "left 0.15s",
          boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
        }}
      />
    </button>
  );
}

function PlaceholderSection(props: { label: string; wave: number; description: string }) {
  const { label, wave, description } = props;
  return (
    <section>
      <h2
        style={{
          fontSize: "0.95rem",
          fontWeight: 600,
          color: "var(--text-primary)",
          margin: "0 0 6px 0",
        }}
      >
        {label}
      </h2>
      <p style={{ fontSize: "0.78rem", color: "var(--text-secondary)", margin: "0 0 24px 0", lineHeight: 1.55 }}>
        {description}
      </p>
      <div
        style={{
          padding: "24px",
          border: "1px dashed var(--border-default)",
          borderRadius: "var(--radius)",
          background: "var(--surface-1, transparent)",
          color: "var(--text-muted)",
          fontSize: "0.8rem",
          textAlign: "center",
          fontFamily: "var(--font-body)",
        }}
      >
        Coming in wave {wave}.
      </div>
    </section>
  );
}
