"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Settings as SettingsIcon } from "lucide-react";
import { queryKeys } from "@/lib/queryKeys";
import type { FeatureFlagKey, InitStatus, MinderConfig } from "@/lib/types";
import { FEATURE_FLAG_META, getFlag } from "@/lib/featureFlags";
import { useToast } from "@/components/ToastProvider";
import { useConfigRefresh } from "@/components/ConfigProvider";
import { NotificationsSection } from "@/components/settings/NotificationsSection";
import { IntegrationsSection } from "@/components/settings/IntegrationsSection";
import { TerminalSection } from "@/components/settings/TerminalSection";
import { AutoTitleSection } from "@/components/settings/AutoTitleSection";
import { LiveActivitySection } from "@/components/settings/LiveActivitySection";
import { CostSection } from "@/components/settings/CostSection";
import { AdaptersSection } from "@/components/settings/AdaptersSection";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { ScanRootsSection } from "@/components/settings/ScanRootsSection";
import { ClaudeHomesSection } from "@/components/settings/ClaudeHomesSection";
import { Toggle } from "@/components/settings/Toggle";

// Hoisted so each Settings render doesn't re-filter the static metadata.
const FLAG_GROUPS = {
  passive: FEATURE_FLAG_META.filter((f) => f.group === "passive"),
  active: FEATURE_FLAG_META.filter((f) => f.group === "active"),
};

const DB_STATUS_LABEL: Record<InitStatus["state"], string> = {
  idle: "Idle",
  "in-flight": "Initializing…",
  success: "Healthy",
  "transient-failed": "Transient failure (will retry)",
  "permanent-failed": "Permanent failure",
};

const DB_STATUS_COLOR: Record<InitStatus["state"], string> = {
  idle: "var(--text-muted)",
  "in-flight": "var(--text-muted)",
  success: "var(--text-muted)",
  "transient-failed": "var(--warning, var(--text-secondary))",
  "permanent-failed": "var(--danger)",
};


type SectionKey =
  | "features"
  | "scan-roots"
  | "claude-homes"
  | "appearance"
  | "cost"
  | "notifications"
  | "integrations"
  | "data"
  | "terminal"
  | "auto-title"
  | "live-activity"
  | "adapters";

interface SectionDef {
  key: SectionKey;
  label: string;
  comingSoon: boolean;
  description: string;
}

const SECTIONS: SectionDef[] = [
  { key: "features",      label: "Features",       comingSoon: false, description: "Subsystem on/off toggles." },
  { key: "scan-roots",    label: "Scan Roots",     comingSoon: false, description: "Directories scanned for projects — add extra drives or WSL locations." },
  { key: "claude-homes",  label: "Claude Homes",   comingSoon: false, description: "Extra .claude session sources (WSL) + cross-environment path mappings." },
  { key: "appearance",    label: "Appearance",     comingSoon: false, description: "View mode, theme, keyboard shortcuts." },
  { key: "cost",          label: "Cost",           comingSoon: false, description: "Currency, pricing rules, schedule mode for burndown." },
  { key: "notifications", label: "Notifications",  comingSoon: false, description: "Push and Telegram event toggles." },
  { key: "integrations",  label: "Integrations",   comingSoon: false, description: "OTEL, Anthropic OAuth, currency API status." },
  { key: "data",          label: "Data & Privacy", comingSoon: true,  description: "History retention, distillation defaults, export shortcuts." },
  { key: "terminal",      label: "Terminal",        comingSoon: false, description: "Preferred terminal application for resume." },
  { key: "auto-title",    label: "Auto-title",      comingSoon: false, description: "LLM endpoint for session-title generation." },
  { key: "live-activity", label: "Live Activity",   comingSoon: false, description: "Hook server install/remove + awaiting-permission alerts." },
  { key: "adapters",      label: "Adapters",        comingSoon: false, description: "Platform adapters: enable/disable session sources (Claude Code, Codex, Gemini)." },
];

export function SettingsPage() {
  const { showToast } = useToast();
  // Re-pull the global ConfigProvider snapshot after a save so provider-backed
  // reads (feature-flag gates like useServerActionsEnabled, useEffectiveShortcuts)
  // reflect the change without a hard reload.
  const refreshGlobalConfig = useConfigRefresh();
  const [active, setActive] = useState<SectionKey>("features");
  const [config, setConfig] = useState<MinderConfig | null>(null);

  // Honor a `?section=` deep-link once on mount (e.g. the /instructions empty
  // state links to /settings?section=adapters). Read from window rather than
  // useSearchParams() to avoid the Suspense-boundary requirement that hook
  // imposes on a client page. Invalid/absent values keep the default section.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("section");
    if (requested && SECTIONS.some((s) => s.key === requested)) {
      setActive(requested as SectionKey);
    }
  }, []);
  // Tracks every flag with an in-flight PATCH so overlapping toggles
  // don't clear each other's saving indicator. A single FeatureFlagKey
  // would race: toggle A starts → A's setSaving(A); toggle B starts →
  // setSaving(B); A finishes → setSaving(null) clears B's indicator
  // even though B's request is still in flight.
  const [saving, setSaving] = useState<ReadonlySet<FeatureFlagKey>>(() => new Set());

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
    setSaving((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
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
      // Keep the global provider (and its flag gates) in sync mid-session.
      refreshGlobalConfig();
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
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  const activeSection = SECTIONS.find((s) => s.key === active);

  // Polls /api/health every 15s. Migrated from a setInterval loop to useQuery
  // (C2): `refetchInterval` keeps the 15s cadence and `refetchIntervalInBackground:
  // false` pauses it on a hidden tab. TanStack's structural sharing returns the
  // prior reference when a field-equal response arrives, so the `select` below
  // still avoids re-rendering InitStatusRow on an unchanged tick (replacing the
  // old `dbStatusEqual` guard). Health failures stay quiet (no toast).
  //
  // `select` returns an object rather than the bare `db` slice so the running
  // version can ride along on the poll this page already makes. TanStack caches
  // the select result against the `data` reference, so an unchanged tick still
  // returns the prior object — the no-re-render property the note above
  // describes is preserved, not traded away for the extra field.
  const healthQuery = useQuery({
    queryKey: queryKeys.health(),
    queryFn: async ({ signal }): Promise<{ db: InitStatus; version?: string }> => {
      const res = await fetch("/api/health", { signal });
      // 503 is not a failure to read: `/api/health` answers 503 for every DB
      // state other than `success` and carries the FULL body regardless of
      // status code, by documented contract (see the route's header comment).
      // A bare `!res.ok` throw therefore discarded the payload in exactly the
      // situation it exists to describe — `InitStatusRow` renders nothing on a
      // null status, so the DB status row vanished whenever the DB was
      // actually broken, which is when a user goes looking for it.
      if (!res.ok && res.status !== 503) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    select: (data) => ({ db: data.db, version: data.version ?? null }),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
  const dbStatus: InitStatus | null = healthQuery.data?.db ?? null;
  // Null only before the first tick, or if the server is genuinely unreachable
  // — a degraded (503) server still reports its version, per the queryFn note
  // above. Rendering nothing in that window is deliberate: an absent version is
  // better than a stale or guessed one.
  const appVersion: string | null = healthQuery.data?.version ?? null;

  async function patchConfig(patch: Partial<MinderConfig>): Promise<void> {
    const res = await fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = body.error || `HTTP ${res.status}`;
      showToast("Couldn't save setting", message);
      throw new Error(message);
    }
    const updated = await res.json().catch(() => null);
    if (updated?.config) setConfig(updated.config as MinderConfig);
    // Keep the global provider (and its flag gates) in sync mid-session.
    refreshGlobalConfig();
  }

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
                {s.comingSoon && (
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.6rem",
                      color: "var(--text-muted)",
                    }}
                  >
                    Soon
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        {appVersion && (
          <p
            style={{
              margin: "16px 0 0 0",
              padding: "0 10px",
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--text-muted)",
            }}
            title="The version of the server currently running"
          >
            v{appVersion}
          </p>
        )}
      </aside>

      <main style={{ flex: 1, minWidth: 0 }}>
        {active === "features" && (
          <FeaturesSection config={config} saving={saving} onToggle={toggleFlag} />
        )}
        {active === "scan-roots" && (
          <ScanRootsSection config={config} onConfigChange={patchConfig} />
        )}
        {active === "claude-homes" && (
          <ClaudeHomesSection config={config} onConfigChange={patchConfig} />
        )}
        {active === "notifications" && (
          <NotificationsSection config={config} onConfigChange={patchConfig} />
        )}
        {active === "integrations" && (
          <IntegrationsSection config={config} onConfigChange={patchConfig} />
        )}
        {active === "terminal" && (
          <TerminalSection config={config} onConfigChange={patchConfig} />
        )}
        {active === "auto-title" && (
          <AutoTitleSection config={config} onConfigChange={patchConfig} />
        )}
        {active === "live-activity" && (
          <LiveActivitySection config={config} onConfigChange={patchConfig} />
        )}
        {active === "cost" && (
          <CostSection config={config} onConfigChange={patchConfig} />
        )}
        {active === "adapters" && (
          <AdaptersSection config={config} onConfigChange={patchConfig} />
        )}
        {active === "appearance" && (
          <AppearanceSection config={config} onConfigChange={patchConfig} />
        )}
        {activeSection?.comingSoon && (
          <PlaceholderSection
            label={activeSection.label}
            description={activeSection.description}
          />
        )}
        <InitStatusRow status={dbStatus} />
      </main>
    </div>
  );
}

function InitStatusRow({ status }: { status: InitStatus | null }) {
  if (!status) return null;
  return (
    <div
      style={{
        marginTop: "32px",
        paddingTop: "12px",
        borderTop: "1px solid var(--border-subtle)",
        fontSize: "0.7rem",
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)",
        display: "flex",
        gap: "12px",
        flexWrap: "wrap",
      }}
      title={
        status.lastError
          ? `${status.lastError.message}${status.lastError.code ? ` (${status.lastError.code})` : ""}`
          : undefined
      }
    >
      <span>
        DB status:{" "}
        <span style={{ color: DB_STATUS_COLOR[status.state] }}>
          {DB_STATUS_LABEL[status.state]}
        </span>
      </span>
      <span>attempts: {status.attempts}</span>
      <span>quarantines: {status.quarantineRuns}</span>
      {status.lastError && <span>last error: {status.lastError.message.slice(0, 80)}</span>}
    </div>
  );
}

function FeaturesSection(props: {
  config: MinderConfig | null;
  saving: ReadonlySet<FeatureFlagKey>;
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
  saving: ReadonlySet<FeatureFlagKey>;
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
          // Honor each flag's real default so an opt-in flag (defaultOn:false)
          // shows OFF until explicitly enabled, matching its server gate —
          // rather than a misleading ON from the blanket default-on.
          const value = getFlag(currentFlags, f.key, f.defaultOn ?? true);
          const isSaving = saving.has(f.key);
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
                      title="The toggle persists, but no consumer reads it yet."
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
                label={f.label}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PlaceholderSection(props: { label: string; description: string }) {
  const { label, description } = props;
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
        Coming soon.
      </div>
    </section>
  );
}
