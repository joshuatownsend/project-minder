"use client";

import { useEffect, useState } from "react";
import { Settings, Search, Webhook, Server, Workflow as WorkflowIcon, Cloud, Box, Sliders, Key } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useConfig, type HookRow, type McpRow, type CicdRow, type SettingsKeyRow } from "@/hooks/useConfig";
import { CONFIG_TYPES, type ConfigType, type PluginEntry, type Workflow } from "@/lib/types";
import { ConfigDashboard } from "./ConfigDashboard";
import { Pill, inlineCode, mutedMono, commandPreview, fileBasename, type PillTone } from "./config/primitives";
import { ApplyUnitButton } from "./ApplyUnitButton";

type TabKey = ConfigType | "settings";

const TABS: { key: TabKey; label: string; icon: typeof Webhook }[] = [
  { key: "settings",     label: "Settings",   icon: Sliders },
  { key: "hooks",        label: "Hooks",      icon: Webhook },
  { key: "plugins",      label: "Plugins",    icon: Box },
  { key: "mcp",          label: "MCP",        icon: Server },
  { key: "cicd",         label: "CI / CD",    icon: WorkflowIcon },
  { key: "settingskeys", label: "Keys",       icon: Key },
];

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

  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), 300);
    return () => clearTimeout(t);
  }, [rawQuery]);

  const catalogType: ConfigType | undefined =
    activeTab === "settings" ? undefined : activeTab;
  const { data, loading } = useConfig(catalogType, projectFilter, query || undefined);

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

      {activeTab !== "settings" && (
      <div style={{ position: "relative", maxWidth: "320px" }}>
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
      )}

      {activeTab !== "settings" && loading ? (
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
        <ActiveSection type={activeTab} data={data} />
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
}: {
  type: TabKey;
  data: ReturnType<typeof useConfig>["data"];
}) {
  if (type === "settings") return <ConfigDashboard />;
  if (type === "hooks") return <HooksList rows={data.hooks} />;
  if (type === "plugins") return <PluginsList rows={data.plugins} />;
  if (type === "mcp") return <McpList rows={data.mcp} />;
  if (type === "settingskeys") return <SettingsKeyList rows={data.settingsKeys} />;
  return <CicdList rows={data.cicd} />;
}

// ─── Lists ───────────────────────────────────────────────────────────────────

function HooksList({ rows }: { rows: HookRow[] }) {
  if (rows.length === 0) return <Empty label="No hooks configured." />;
  return (
    <div>
      {rows.map((h, i) => (
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
      ))}
    </div>
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

function McpList({ rows }: { rows: McpRow[] }) {
  if (rows.length === 0) return <Empty label="No MCP servers configured." />;
  return (
    <div>
      {rows.map((m, i) => (
        <div
          key={`${m.name}-${i}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "7px 0",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-primary)" }}>
            {m.name}
          </span>
          <Pill>{m.transport}</Pill>
          <span style={{ flex: 1, minWidth: 0, fontSize: "0.68rem", color: "var(--text-secondary)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {m.command ? `${m.command}${m.args ? " " + m.args.join(" ") : ""}` : m.url ?? ""}
          </span>
          {m.envKeys && m.envKeys.length > 0 && (
            <span style={mutedMono} title={`env: ${m.envKeys.join(", ")}`}>
              env {m.envKeys.length}
            </span>
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
      ))}
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
