"use client";

import { useEffect, useMemo, useState } from "react";
import { Settings, Search, Webhook, Server, Workflow as WorkflowIcon, Cloud, Box, Sliders, Key, Camera } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useConfig, type HookRow, type McpRow, type CicdRow, type SettingsKeyRow } from "@/hooks/useConfig";
import { CONFIG_TYPES, type ConfigType, type PluginEntry, type Workflow } from "@/lib/types";
import { ConfigDashboard } from "./ConfigDashboard";
import dynamic from "next/dynamic";

// Playground tab is lazy-loaded — its module only ships in the /config
// chunk for users who actually click the tab. Saves a few KB on first
// load for the dashboard.
const ScreenshotToCodePlayground = dynamic(
  () => import("./ScreenshotToCodePlayground").then((m) => m.ScreenshotToCodePlayground),
  { ssr: false },
);
import { Pill, inlineCode, mutedMono, commandPreview, fileBasename, type PillTone } from "./config/primitives";
import { ApplyUnitButton } from "./ApplyUnitButton";
import { CopyInvocationButton } from "@/components/CopyInvocationButton";
import { computeEffectiveMcp, computeEffectiveHooks, type EffectiveState } from "@/lib/effectiveConfig";
import type { McpFinding, McpFindingSeverity } from "@/lib/types";
import { ShieldAlert, RefreshCw } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";
import { buildServerId } from "@/lib/scanner/mcp-security/ids";

type TabKey = ConfigType | "settings" | "playground";

const TABS: { key: TabKey; label: string; icon: typeof Webhook }[] = [
  { key: "settings",     label: "Settings",   icon: Sliders },
  { key: "hooks",        label: "Hooks",      icon: Webhook },
  { key: "plugins",      label: "Plugins",    icon: Box },
  { key: "mcp",          label: "MCP",        icon: Server },
  { key: "cicd",         label: "CI / CD",    icon: WorkflowIcon },
  { key: "settingskeys", label: "Keys",       icon: Key },
  { key: "playground",   label: "Playground", icon: Camera },
];

const NON_CATALOG_TABS = new Set<TabKey>(["settings", "playground"]);

export function ConfigBrowser() {
  const searchParams = useSearchParams();

  // Initial tab from ?type= URL param. Falls back to "settings" when missing
  // or invalid. Project filter from ?project= scopes the rollup so a deep
  // link from a dashboard card lands directly on its rows.
  const initialTab: TabKey = (() => {
    const t = searchParams?.get("type");
    if (!t) return "settings";
    if ((CONFIG_TYPES as readonly string[]).includes(t)) return t as TabKey;
    return "settings";
  })();
  const projectFilter = searchParams?.get("project") || undefined;

  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [effectiveView, setEffectiveView] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), 300);
    return () => clearTimeout(t);
  }, [rawQuery]);

  const catalogType: ConfigType | undefined = NON_CATALOG_TABS.has(activeTab)
    ? undefined
    : (activeTab as ConfigType);
  const { data, loading, refresh } = useConfig(catalogType, projectFilter, query || undefined);

  const effectiveMcp = useMemo(
    () => (effectiveView ? computeEffectiveMcp(data.mcp) : null),
    [effectiveView, data.mcp],
  );
  const effectiveHooks = useMemo(
    () => (effectiveView ? computeEffectiveHooks(data.hooks) : null),
    [effectiveView, data.hooks],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <Settings style={{ width: "14px", height: "14px", color: "var(--text-muted)" }} />
        <h1
          style={{
            fontSize: "0.72rem",
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-body)",
            margin: 0,
          }}
        >
          Config
        </h1>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
          hooks · plugins · MCP · CI/CD
        </span>
      </header>

      <nav style={{ display: "flex", gap: "2px", borderBottom: "1px solid var(--border-subtle)" }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.key;
          const count = countFor(t.key, data);
          return (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 14px",
                fontSize: "0.72rem",
                fontFamily: "var(--font-body)",
                fontWeight: active ? 600 : 400,
                color: active ? "var(--text-primary)" : "var(--text-secondary)",
                background: "transparent",
                border: "none",
                borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                cursor: "pointer",
                marginBottom: "-1px",
              }}
            >
              <Icon style={{ width: "12px", height: "12px" }} />
              {t.label}
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)" }}>
                {count}
              </span>
            </button>
          );
        })}
      </nav>

      {!NON_CATALOG_TABS.has(activeTab) && (
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <div style={{ position: "relative", flex: "1 1 200px", maxWidth: "320px" }}>
          <Search
            style={{
              position: "absolute",
              left: "9px",
              top: "50%",
              transform: "translateY(-50%)",
              width: "13px",
              height: "13px",
              color: "var(--text-muted)",
              pointerEvents: "none",
            }}
          />
          <input
            type="text"
            placeholder={`Search ${activeTab}…`}
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            style={{
              width: "100%",
              padding: "5px 9px 5px 28px",
              fontSize: "0.72rem",
              fontFamily: "var(--font-body)",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              color: "var(--text-primary)",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>
        {(activeTab === "mcp" || activeTab === "hooks") && (
          <button
            onClick={() => setEffectiveView((v) => !v)}
            style={{
              padding: "4px 10px",
              fontSize: "0.65rem",
              fontFamily: "var(--font-body)",
              fontWeight: effectiveView ? 600 : 400,
              color: effectiveView ? "var(--info)" : "var(--text-muted)",
              background: effectiveView ? "var(--info-bg)" : "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            effective view
          </button>
        )}
      </div>
      )}

      {!NON_CATALOG_TABS.has(activeTab) && loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {[...Array(6)].map((_, i) => (
            <div
              key={i}
              style={{
                height: "32px",
                background: "var(--bg-surface)",
                borderRadius: "var(--radius)",
                opacity: 0.5,
              }}
            />
          ))}
        </div>
      ) : (
        <ActiveSection
          type={activeTab}
          data={data}
          effectiveMcp={effectiveMcp}
          effectiveHooks={effectiveHooks}
          onMcpToggle={async (projectSlug, serverName, enabled) => {
            const res = await fetch(`/api/projects/${encodeURIComponent(projectSlug)}/mcp-toggle`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ serverName, enabled }),
            });
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error((body as { error?: string }).error ?? `Toggle failed (${res.status})`);
            }
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function countFor(type: TabKey, data: ReturnType<typeof useConfig>["data"]): number {
  switch (type) {
    case "hooks":        return data.hooks.length;
    case "plugins":      return data.plugins.length;
    case "mcp":          return data.mcp.length;
    case "cicd":         return data.cicd.reduce((acc, c) => acc + c.cicd.workflows.length, 0);
    case "settingskeys": return data.settingsKeys.length;
    default:             return 0;
  }
}

function ActiveSection({
  type,
  data,
  effectiveMcp,
  effectiveHooks,
  onMcpToggle,
}: {
  type: TabKey;
  data: ReturnType<typeof useConfig>["data"];
  effectiveMcp: Map<string, EffectiveState> | null;
  effectiveHooks: Map<string, EffectiveState> | null;
  onMcpToggle: (projectSlug: string, serverName: string, enabled: boolean) => Promise<void>;
}) {
  if (type === "settings") return <ConfigDashboard />;
  if (type === "playground") return <ScreenshotToCodePlayground />;
  if (type === "hooks") return <HooksList rows={data.hooks} effectiveStates={effectiveHooks} />;
  if (type === "plugins") return <PluginsList rows={data.plugins} />;
  if (type === "mcp") return <McpList rows={data.mcp} effectiveStates={effectiveMcp} onToggle={onMcpToggle} />;
  if (type === "settingskeys") return <SettingsKeyList rows={data.settingsKeys} />;
  return <CicdList rows={data.cicd} />;
}

// ─── Lists ───────────────────────────────────────────────────────────────────

function HooksList({ rows, effectiveStates }: { rows: HookRow[]; effectiveStates: Map<string, EffectiveState> | null }) {
  if (rows.length === 0) return <Empty label="No hooks configured." />;
  return (
    <div>
      {rows.map((h, i) => {
        const hookState = effectiveStates?.get(h.unitKey) ?? null;
        return (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "7px 0",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <Pill tone="info">{h.event}</Pill>
          <span style={{ flex: 1, minWidth: 0, fontSize: "0.72rem", display: "inline-flex", gap: "6px", alignItems: "center", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
            {h.matcher && <code style={inlineCode}>{h.matcher}</code>}
            <span style={{ color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis" }}>
              {commandPreview(h.commands[0]?.command, h.commands.length)}
            </span>
          </span>
          {h.source === "local" && <LocalScopeBadge />}
          {hookState && <EffectiveBadge state={hookState} />}
          {h.projectSlug ? (
            <ApplyUnitButton
              unit={{ kind: "hook", key: h.unitKey }}
              source={{ kind: "project", slug: h.projectSlug }}
              excludeTargetSlugs={[h.projectSlug]}
              compact
            />
          ) : h.source === "user" ? (
            <ApplyUnitButton
              unit={{ kind: "hook", key: h.unitKey }}
              source={{ kind: "user" }}
              compact
            />
          ) : null}
          <SourceBadge projectSlug={h.projectSlug} projectName={h.projectName} />
        </div>
        );
      })}
    </div>
  );
}

const EFFECTIVE_BADGE: Record<EffectiveState, { label: string; color: string; title: string }> = {
  active:   { label: "active",    color: "var(--success, #22c55e)",      title: "This entry is active in Claude Code" },
  shadowed: { label: "shadowed",  color: "var(--text-muted)",             title: "A higher-precedence entry with the same name overrides this one" },
  disabled: { label: "disabled",  color: "var(--warning, #f59e0b)",       title: "This entry is explicitly disabled" },
  conflict: { label: "conflict",  color: "var(--error, #ef4444)",         title: "This key appears in multiple scopes and may run more than once" },
};

function EffectiveBadge({ state }: { state: EffectiveState }) {
  const { label, color, title } = EFFECTIVE_BADGE[state];
  return (
    <span
      title={title}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        color,
        border: "1px solid var(--border-subtle)",
        borderRadius: "3px",
        padding: "1px 5px",
        letterSpacing: "0.04em",
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

/** Small chip on a hook row indicating the source was `.claude/settings.local.json`
 *  (per-machine config) rather than `.claude/settings.json` (project-shared).
 *  Templates that copy a `local` hook auto-promote it to project-shared at the
 *  target — surfacing this on the source row makes that decision transparent. */
function LocalScopeBadge() {
  return (
    <span
      title=".claude/settings.local.json — per-machine; copying via Template Mode auto-promotes to settings.json (project-shared)"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        color: "var(--warning, #f59e0b)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "3px",
        padding: "1px 5px",
        letterSpacing: "0.04em",
      }}
    >
      local
    </span>
  );
}

function PluginsList({ rows }: { rows: PluginEntry[] }) {
  if (rows.length === 0) return <Empty label="No plugins installed." />;
  return (
    <div>
      {rows.map((p) => {
        const status: "enabled" | "disabled" | "blocked" = p.blocked
          ? "blocked"
          : p.enabled
          ? "enabled"
          : "disabled";
        return (
          <div
            key={`${p.name}@${p.marketplace}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "7px 0",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <span style={{ flex: 1, minWidth: 0, fontSize: "0.78rem", fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {p.name}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)" }}>
              {p.marketplace}
            </span>
            {p.version && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)" }}>
                v{p.version}
              </span>
            )}
            {p.enabled && (
              <ApplyUnitButton
                unit={{ kind: "plugin", key: p.marketplace ? `${p.name}@${p.marketplace}` : p.name }}
                source={{ kind: "user" }}
                compact
              />
            )}
            <StatusPill status={status} />
          </div>
        );
      })}
    </div>
  );
}

function SettingsKeyList({ rows }: { rows: SettingsKeyRow[] }) {
  if (rows.length === 0) {
    return <Empty label="No extra settings keys in ~/.claude/settings.json." />;
  }
  return (
    <div>
      {rows.map((sk) => (
        <div
          key={sk.keyPath}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "7px 0",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--accent)", flexShrink: 0 }}>
            {sk.keyPath}
          </code>
          <span style={{ flex: 1, minWidth: 0, fontSize: "0.68rem", color: "var(--text-secondary)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {truncateJson(sk.value)}
          </span>
          <ApplyUnitButton
            unit={{ kind: "settingsKey", key: sk.keyPath }}
            source={{ kind: "user" }}
            compact
          />
        </div>
      ))}
    </div>
  );
}

function truncateJson(value: unknown, max = 48): string {
  const s = JSON.stringify(value) ?? "null";
  return s.length <= max ? s : s.slice(0, max) + "…";
}

// ── MCP security helpers ─────────────────────────────────────────────────────

const SEVERITY_ORDER: McpFindingSeverity[] = ["crit", "high", "med", "low", "info"];

const SEVERITY_COLORS: Record<McpFindingSeverity, string> = {
  crit: "var(--destructive, #ef4444)",
  high: "#f97316",
  med:  "var(--warning, #f59e0b)",
  low:  "var(--text-secondary)",
  info: "var(--text-muted)",
};

function SeverityChips({ findings }: { findings: McpFinding[] }) {
  const counts: Partial<Record<McpFindingSeverity, number>> = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  const active = SEVERITY_ORDER.filter((s) => (counts[s] ?? 0) > 0);
  if (active.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", gap: "3px", flexShrink: 0 }}>
      {active.map((sev) => (
        <span
          key={sev}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.58rem",
            color: SEVERITY_COLORS[sev],
            border: `1px solid ${SEVERITY_COLORS[sev]}`,
            borderRadius: "3px",
            padding: "1px 4px",
            whiteSpace: "nowrap",
          }}
          title={`${sev}: ${counts[sev]} finding${(counts[sev] ?? 0) > 1 ? "s" : ""}`}
        >
          {sev}:{counts[sev]}
        </span>
      ))}
    </span>
  );
}

interface SecurityPayload {
  findings: McpFinding[];
  lastRunAt: number | null;
  durationMs: number | null;
  serversScanned: number;
}

function McpSecurityBanner({
  data,
  loading,
  onRefresh,
}: {
  data: SecurityPayload | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const ageLabel = data?.lastRunAt
    ? formatRelativeTime(new Date(data.lastRunAt).toISOString())
    : "never";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "7px 10px",
        marginBottom: "8px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        fontSize: "0.7rem",
        color: "var(--text-secondary)",
      }}
    >
      <ShieldAlert size={13} style={{ color: data?.findings.length ? "var(--warning, #f59e0b)" : "var(--text-muted)", flexShrink: 0 }} />
      <span>
        {loading
          ? "Scanning…"
          : data
          ? `Last scan: ${ageLabel} · ${data.serversScanned} servers · ${data.findings.length} finding${data.findings.length !== 1 ? "s" : ""}`
          : "No scan data"}
      </span>
      <button
        onClick={onRefresh}
        disabled={loading}
        title="Re-run security scan"
        style={{
          marginLeft: "auto",
          background: "none",
          border: "none",
          cursor: loading ? "wait" : "pointer",
          color: "var(--text-secondary)",
          padding: "2px",
          display: "flex",
          alignItems: "center",
        }}
      >
        <RefreshCw size={11} style={{ opacity: loading ? 0.4 : 1 }} />
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function McpList({
  rows,
  effectiveStates,
  onToggle,
}: {
  rows: McpRow[];
  effectiveStates: Map<string, EffectiveState> | null;
  onToggle: (projectSlug: string, serverName: string, enabled: boolean) => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [securityData, setSecurityData] = useState<SecurityPayload | null>(null);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [expandedSecurity, setExpandedSecurity] = useState<Set<string>>(new Set());

  async function fetchSecurity(refresh = false) {
    setSecurityLoading(true);
    try {
      const url = `/api/mcp-security/findings${refresh ? "?refresh=1" : ""}`;
      const res = await fetch(url);
      if (res.ok) setSecurityData(await res.json());
    } catch {
      // non-fatal: security panel just stays empty
    } finally {
      setSecurityLoading(false);
    }
  }

  useEffect(() => { fetchSecurity(); }, []);

  const findingsByServer = useMemo(() => {
    if (!securityData) return new Map<string, McpFinding[]>();
    const map = new Map<string, McpFinding[]>();
    for (const f of securityData.findings) {
      const list = map.get(f.serverId) ?? [];
      list.push(f);
      map.set(f.serverId, list);
    }
    return map;
  }, [securityData]);

  function serverIdFor(m: McpRow): string {
    return buildServerId(m.source, m.name, m.projectSlug ?? undefined);
  }

  if (rows.length === 0) return <Empty label="No MCP servers configured." />;
  return (
    <div>
      <McpSecurityBanner
        data={securityData}
        loading={securityLoading}
        onRefresh={() => fetchSecurity(true)}
      />
      {toggleError && (
        <div style={{ color: "var(--destructive, #ef4444)", fontSize: "0.75rem", padding: "4px 0 8px" }}>
          {toggleError}
        </div>
      )}
      {rows.map((m, i) => {
        // effectiveStates is keyed by server name. Same-named servers across scopes
        // intentionally share the same effective state: duplicates → "conflict" on every row.
        const mcpState = effectiveStates?.get(m.name) ?? (m.disabled ? "disabled" : null);
        const sId = serverIdFor(m);
        const serverFindings = findingsByServer.get(sId) ?? [];
        const isExpanded = expandedSecurity.has(sId);
        const canToggle = m.source === "project" && !!m.projectSlug;
        const toggleKey = `${m.projectSlug}:${m.name}`;

        async function handleMcpToggle(e: React.MouseEvent) {
          e.stopPropagation();
          if (!canToggle || !m.projectSlug || pending) return;
          setPending(toggleKey);
          setToggleError(null);
          try {
            await onToggle(m.projectSlug, m.name, !!m.disabled);
          } catch (err) {
            setToggleError(err instanceof Error ? err.message : "Toggle failed");
          } finally {
            setPending(null);
          }
        }

        function toggleSecurityExpand(e: React.MouseEvent) {
          e.stopPropagation();
          setExpandedSecurity((prev) => {
            const next = new Set(prev);
            if (next.has(sId)) next.delete(sId); else next.add(sId);
            return next;
          });
        }

        return (
        <div key={`${m.name}-${i}`} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "7px 0",
              opacity: m.disabled ? 0.6 : 1,
            }}
          >
            <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-primary)" }}>
              {m.name}
            </span>
            <Pill>{m.transport}</Pill>
            <CopyInvocationButton
              text={`mcp__${m.name}__`}
              title={`Copy MCP prefix: mcp__${m.name}__  (append the tool name, e.g. mcp__${m.name}__list_files)`}
            />
            <span style={{ flex: 1, minWidth: 0, fontSize: "0.68rem", color: "var(--text-secondary)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {m.command ? `${m.command}${m.args ? " " + m.args.join(" ") : ""}` : m.url ?? ""}
            </span>
            {m.envKeys && m.envKeys.length > 0 && (
              <span style={mutedMono} title={`env: ${m.envKeys.join(", ")}`}>
                env {m.envKeys.length}
              </span>
            )}
            {m.disabled && !effectiveStates && (
              <span
                style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--warning, #f59e0b)", border: "1px solid var(--border-subtle)", borderRadius: "3px", padding: "1px 5px" }}
              >
                disabled
              </span>
            )}
            {mcpState && <EffectiveBadge state={mcpState} />}
            {serverFindings.length > 0 && (
              <button
                onClick={toggleSecurityExpand}
                style={{ background: "none", border: "none", cursor: "pointer", padding: "0", display: "flex", alignItems: "center", gap: "3px" }}
                title={isExpanded ? "Hide security findings" : "Show security findings"}
              >
                <SeverityChips findings={serverFindings} />
              </button>
            )}
            {canToggle && (
              <button
                onClick={handleMcpToggle}
                disabled={pending === toggleKey}
                title={m.disabled ? "Re-enable server" : "Disable server (writes to .claude/settings.local.json)"}
                style={{
                  padding: "2px 7px",
                  fontSize: "0.6rem",
                  fontFamily: "var(--font-body)",
                  background: m.disabled ? "var(--warning-bg, rgba(245,158,11,0.12))" : "var(--bg-surface)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "3px",
                  color: m.disabled ? "var(--warning, #f59e0b)" : "var(--text-muted)",
                  cursor: pending === toggleKey ? "wait" : "pointer",
                  opacity: pending === toggleKey ? 0.5 : 1,
                  flexShrink: 0,
                }}
              >
                {pending === toggleKey ? "…" : m.disabled ? "enable" : "disable"}
              </button>
            )}
            {m.projectSlug ? (
              <ApplyUnitButton
                unit={{ kind: "mcp", key: m.name }}
                source={{ kind: "project", slug: m.projectSlug }}
                excludeTargetSlugs={[m.projectSlug]}
                compact
              />
            ) : m.source === "user" ? (
              <ApplyUnitButton
                unit={{ kind: "mcp", key: m.name }}
                source={{ kind: "user" }}
                compact
              />
            ) : null}
            <SourceBadge projectSlug={m.projectSlug} projectName={m.projectName} />
          </div>
          {isExpanded && serverFindings.length > 0 && (
            <div style={{ paddingBottom: "8px", paddingLeft: "12px", display: "flex", flexDirection: "column", gap: "4px" }}>
              {serverFindings.map((f) => (
                <div
                  key={`${f.ruleId}-${f.surface}-${f.foundAtMs}`}
                  style={{ display: "flex", gap: "6px", fontSize: "0.68rem", alignItems: "baseline" }}
                >
                  <span style={{ color: SEVERITY_COLORS[f.severity], fontFamily: "var(--font-mono)", flexShrink: 0 }}>{f.severity}</span>
                  <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>{f.ruleId}</span>
                  <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{f.surface}{f.surfaceRef ? ` (${f.surfaceRef})` : ""}</span>
                  <span style={{ color: "var(--text-secondary)" }}>{f.message}</span>
                  {f.evidence && (
                    <span
                      style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--text-muted)", background: "var(--bg-elevated)", padding: "0 4px", borderRadius: "3px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "200px" }}
                      title={f.evidence}
                    >
                      {f.evidence}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}

function CicdList({ rows }: { rows: CicdRow[] }) {
  if (rows.length === 0) return <Empty label="No CI/CD configuration detected." />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {rows.map((row) => (
        <div
          key={row.projectSlug}
          style={{
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            padding: "12px 14px",
            background: "var(--bg-surface)",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Link
              href={`/project/${row.projectSlug}`}
              style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-primary)", textDecoration: "none" }}
            >
              {row.projectName}
            </Link>
            <span style={mutedMono}>
              {row.cicd.workflows.length} workflow{row.cicd.workflows.length === 1 ? "" : "s"} ·{" "}
              {row.cicd.hosting.length} host{row.cicd.hosting.length === 1 ? "" : "s"} ·{" "}
              {row.cicd.dependabot.length} dependabot
            </span>
          </div>

          {row.cicd.hosting.length > 0 && (
            <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
              {row.cicd.hosting.map((h) => (
                <Pill key={`${h.platform}:${h.sourcePath}`} tone="info">
                  <Cloud style={{ width: "9px", height: "9px", marginRight: "3px" }} />
                  {h.platform}
                </Pill>
              ))}
            </div>
          )}

          {row.cicd.workflows.map((w) => (
            <WorkflowMini key={w.file} workflow={w} />
          ))}
        </div>
      ))}
    </div>
  );
}

function WorkflowMini({ workflow: w }: { workflow: Workflow }) {
  const allUses = Array.from(new Set(w.jobs.flatMap((j) => j.actionUses)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "3px", borderTop: "1px solid var(--border-subtle)", paddingTop: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
        <code style={inlineCode}>{fileBasename(w.file)}</code>
        {w.name && <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>{w.name}</span>}
        {w.triggers.map((t) => (
          <Pill key={t}>{t}</Pill>
        ))}
        {w.cron.map((c) => (
          <code key={c} style={inlineCode}>{c}</code>
        ))}
      </div>
      {allUses.length > 0 && (
        <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
          {allUses.slice(0, 8).map((u) => (
            <code key={u} style={inlineCode}>{u}</code>
          ))}
          {allUses.length > 8 && <span style={mutedMono}>+{allUses.length - 8}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function SourceBadge({ projectSlug, projectName }: { projectSlug?: string; projectName?: string }) {
  if (!projectSlug || !projectName) {
    return (
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)", border: "1px solid var(--border-subtle)", borderRadius: "3px", padding: "1px 5px" }}>
        user
      </span>
    );
  }
  return (
    <Link
      href={`/project/${projectSlug}`}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        color: "var(--info)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "3px",
        padding: "1px 5px",
        textDecoration: "none",
      }}
      title={`project: ${projectName}`}
    >
      {projectName}
    </Link>
  );
}

function StatusPill({ status }: { status: "enabled" | "disabled" | "blocked" }) {
  const tone: PillTone =
    status === "enabled" ? "info" : status === "blocked" ? "warn" : "default";
  return <Pill tone={tone}>{status}</Pill>;
}

function Empty({ label }: { label: string }) {
  return (
    <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem" }}>
      {label}
    </div>
  );
}
