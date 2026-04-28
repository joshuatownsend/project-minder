"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AgentEntry,
  SkillEntry,
} from "@/lib/indexer/types";
import type {
  CommandEntry,
  HookEntry,
  McpServer,
  ProjectData,
  TemplateUnitInventory,
  TemplateUnitRef,
  UnitKind,
  Workflow,
} from "@/lib/types";

interface Props {
  project: ProjectData;
  onClose: () => void;
}

interface PluginEnableRow {
  key: string;
  name: string;
  marketplace: string;
  enabled: boolean;
  source: "project" | "local";
  installed: boolean;
}

interface AvailableUnits {
  agents: AgentEntry[];
  skills: SkillEntry[];
  commands: CommandEntry[];
  hooks: HookEntry[];
  mcp: McpServer[];
  plugins: PluginEnableRow[];
  workflows: Workflow[];
}

export function MarkAsTemplateModal({ project, onClose }: Props) {
  const router = useRouter();
  const [slug, setSlug] = useState(`${project.slug}-template`);
  const [name, setName] = useState(`${project.name} template`);
  const [description, setDescription] = useState("");
  const [available, setAvailable] = useState<AvailableUnits | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadUnits() {
      try {
        // Fetch the project's units in parallel. We use the existing
        // /api/agents and /api/skills (filtered by project) plus the
        // claude-config rollup for hooks + MCP, plus a small project-scoped
        // commands listing via the new walker — but commands aren't yet on
        // their own API, so we read the project's CommandEntries from the
        // project detail endpoint when available.
        const [agentsRes, skillsRes, configRes, pluginsRes, commandsRes] = await Promise.all([
          fetch(`/api/agents?source=project&project=${encodeURIComponent(project.slug)}`),
          fetch(`/api/skills?source=project&project=${encodeURIComponent(project.slug)}`),
          fetch(`/api/claude-config?type=all&project=${encodeURIComponent(project.slug)}`),
          fetch(`/api/projects/${encodeURIComponent(project.slug)}/plugins`),
          fetch(`/api/commands?source=project&project=${encodeURIComponent(project.slug)}`),
        ]);
        const [agentsData, skillsData, configData, pluginsData, commandsData] = await Promise.all([
          agentsRes.json(),
          skillsRes.json(),
          configRes.json(),
          pluginsRes.json().catch(() => ({ enables: [] })),
          commandsRes.json().catch(() => []),
        ]);

        // The agents/skills routes return rows in a `{ entry, usage }` shape;
        // pull out the entry objects (and skip rows without one).
        const agentEntries: AgentEntry[] = Array.isArray(agentsData)
          ? agentsData.map((r: { entry?: AgentEntry }) => r.entry).filter(Boolean) as AgentEntry[]
          : [];
        const skillEntries: SkillEntry[] = Array.isArray(skillsData)
          ? skillsData.map((r: { entry?: SkillEntry }) => r.entry).filter(Boolean) as SkillEntry[]
          : [];

        const hooks: HookEntry[] = (configData?.hooks ?? []).filter(
          (h: { projectSlug?: string }) => h.projectSlug === project.slug
        );
        const mcp: McpServer[] = (configData?.mcp ?? []).filter(
          (m: { projectSlug?: string }) => m.projectSlug === project.slug
        );
        // CI/CD payload is grouped per project — flatten the workflows for the
        // requested slug.
        const workflows: Workflow[] = ((configData?.cicd ?? []) as Array<{
          projectSlug?: string;
          cicd?: { workflows?: Workflow[] };
        }>)
          .filter((c) => c.projectSlug === project.slug)
          .flatMap((c) => c.cicd?.workflows ?? []);

        const plugins: PluginEnableRow[] = Array.isArray(pluginsData?.enables)
          ? (pluginsData.enables as PluginEnableRow[]).filter((p) => p.enabled)
          : [];

        const commandEntries: CommandEntry[] = Array.isArray(commandsData)
          ? (commandsData as { entry?: CommandEntry }[])
              .map((r) => r.entry)
              .filter(Boolean) as CommandEntry[]
          : [];

        if (cancelled) return;
        setAvailable({
          agents: agentEntries,
          skills: skillEntries,
          commands: commandEntries,
          hooks,
          mcp,
          plugins,
          workflows,
        });
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      }
    }
    loadUnits();
    return () => {
      cancelled = true;
    };
  }, [project.slug]);

  const allKeys = useMemo(() => collectAllKeys(available), [available]);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(allKeys));
  }

  function clearAll() {
    setSelected(new Set());
  }

  async function onCreate() {
    setCreateError(null);
    if (!available) return;
    const inv = buildInventory(available, selected);
    setBusy(true);
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          name,
          description: description.trim() || undefined,
          sourceSlug: project.slug,
          units: inv,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateError(data?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      // Navigate to the new template's detail page.
      router.push(`/templates/${encodeURIComponent(slug)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={overlay}
    >
      <div onClick={(e) => e.stopPropagation()} style={modal}>
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>
          Mark <code style={inlineCode}>{project.slug}</code> as a template
        </h2>
        <p style={{ marginTop: "4px", fontSize: "0.7rem", color: "var(--text-muted)" }}>
          Creates a <strong>live</strong> template — edits to this project flow through to anywhere the template is applied.
          Promote to a frozen snapshot from the template detail page when you&apos;re ready.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "14px" }}>
          <label style={labelStyle}>
            <span style={subLabel}>template slug</span>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="lowercase-alphanumeric-dash"
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            <span style={subLabel}>name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            <span style={subLabel}>description (optional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              style={{ ...inputStyle, resize: "vertical" }}
              placeholder="What this template is good for…"
            />
          </label>
        </div>

        <div style={{ marginTop: "14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "0.62rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            units to include ({selected.size} selected)
          </span>
          <div style={{ display: "flex", gap: "6px" }}>
            <button onClick={selectAll} style={miniButton}>all</button>
            <button onClick={clearAll} style={miniButton}>none</button>
          </div>
        </div>

        {loadError && (
          <div style={{ color: "var(--error, #ef4444)", fontSize: "0.72rem", marginTop: "8px" }}>{loadError}</div>
        )}
        {!available && !loadError && (
          <div style={{ color: "var(--text-muted)", fontSize: "0.72rem", marginTop: "8px" }}>loading units…</div>
        )}

        {available && (
          <div style={{ marginTop: "8px", maxHeight: "320px", overflowY: "auto", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)" }}>
            <UnitGroup title="agents" entries={available.agents.map((a) => ({ kind: "agent" as UnitKind, key: a.slug, label: a.name, sub: a.description }))} selected={selected} onToggle={toggle} />
            <UnitGroup title="skills" entries={available.skills.map((s) => ({ kind: "skill" as UnitKind, key: `${s.slug}:${s.layout}`, label: s.name, sub: `${s.layout} · ${s.description ?? ""}` }))} selected={selected} onToggle={toggle} />
            <UnitGroup title="commands" entries={available.commands.map((c) => ({ kind: "command" as UnitKind, key: c.slug, label: c.name, sub: c.description }))} selected={selected} onToggle={toggle} />
            <UnitGroup title="hooks" entries={available.hooks.flatMap((h) =>
              h.commands.map((cmd) => ({
                kind: "hook" as UnitKind,
                // Mirror server-side keying — events|matcher|sha256(invocation).
                // The /api/claude-config row exposes `unitKey` for one-shot lookup.
                key: (h as unknown as { unitKey?: string }).unitKey ?? "",
                label: `${h.event}${h.matcher ? ` · ${h.matcher}` : ""}`,
                sub: cmd.command.length > 80 ? cmd.command.slice(0, 76) + "…" : cmd.command,
              })).filter((e) => e.key)
            )} selected={selected} onToggle={toggle} />
            <UnitGroup title="mcp servers" entries={available.mcp.map((m) => ({ kind: "mcp" as UnitKind, key: m.name, label: m.name, sub: `${m.transport}${m.command ? " · " + m.command : ""}${m.url ? " · " + m.url : ""}` }))} selected={selected} onToggle={toggle} />
            <UnitGroup
              title="plugins"
              entries={available.plugins.map((p) => ({
                kind: "plugin" as UnitKind,
                key: p.key,
                label: p.name,
                sub: `${p.marketplace || "no marketplace"} · ${p.installed ? "installed" : "NOT installed at ~/.claude/plugins"}${p.source === "local" ? " · local-scope" : ""}`,
              }))}
              selected={selected}
              onToggle={toggle}
            />
            <UnitGroup
              title="workflows (.github/workflows)"
              entries={available.workflows.map((w) => ({
                kind: "workflow" as UnitKind,
                key: workflowKey(w.file),
                label: w.name ?? workflowKey(w.file),
                sub: `${w.triggers.join(", ") || "no triggers"}${w.cron.length > 0 ? ` · cron: ${w.cron.join(", ")}` : ""}`,
              }))}
              selected={selected}
              onToggle={toggle}
            />
          </div>
        )}

        {createError && (
          <div style={{ marginTop: "10px", color: "var(--error, #ef4444)", fontSize: "0.72rem" }}>{createError}</div>
        )}

        <div style={{ marginTop: "14px", display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={busy} style={secondaryButton(busy)}>
            cancel
          </button>
          <button
            onClick={onCreate}
            disabled={busy || !available || selected.size === 0 || !slug || !name}
            style={primaryButton(busy || !available || selected.size === 0 || !slug || !name)}
          >
            {busy ? "creating…" : "create template"}
          </button>
        </div>
      </div>
    </div>
  );
}

function UnitGroup({
  title,
  entries,
  selected,
  onToggle,
}: {
  title: string;
  entries: { kind: UnitKind; key: string; label: string; sub?: string }[];
  selected: Set<string>;
  onToggle: (k: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div>
      <div
        style={{
          padding: "5px 10px",
          fontSize: "0.62rem",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        {title} ({entries.length})
      </div>
      {entries.map((e) => {
        const id = `${e.kind}:${e.key}`;
        const checked = selected.has(id);
        return (
          <label
            key={id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "8px",
              padding: "6px 10px",
              borderBottom: "1px solid var(--border-subtle)",
              cursor: "pointer",
            }}
          >
            <input type="checkbox" checked={checked} onChange={() => onToggle(id)} />
            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" }}>
              <span style={{ fontSize: "0.74rem", color: "var(--text-primary)", fontWeight: 500 }}>{e.label}</span>
              {e.sub && (
                <span
                  style={{
                    fontSize: "0.62rem",
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {e.sub}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function collectAllKeys(available: AvailableUnits | null): string[] {
  if (!available) return [];
  const keys: string[] = [];
  available.agents.forEach((a) => keys.push(`agent:${a.slug}`));
  available.skills.forEach((s) => keys.push(`skill:${s.slug}:${s.layout}`));
  available.commands.forEach((c) => keys.push(`command:${c.slug}`));
  available.hooks.forEach((h) => {
    const k = (h as unknown as { unitKey?: string }).unitKey;
    if (k) keys.push(`hook:${k}`);
  });
  available.mcp.forEach((m) => keys.push(`mcp:${m.name}`));
  available.plugins.forEach((p) => keys.push(`plugin:${p.key}`));
  available.workflows.forEach((w) => keys.push(`workflow:${workflowKey(w.file)}`));
  return keys;
}

/** Convert an absolute workflow file path to the relative key under
 *  `.github/workflows/` (e.g. "ci.yml") that the apply layer expects. */
function workflowKey(absoluteFilePath: string): string {
  const norm = absoluteFilePath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf(".github/workflows/");
  if (idx === -1) return norm.split("/").pop() ?? norm;
  return norm.slice(idx + ".github/workflows/".length);
}

function buildInventory(available: AvailableUnits, selected: Set<string>): TemplateUnitInventory {
  const inv: TemplateUnitInventory = {
    agents: [],
    skills: [],
    commands: [],
    hooks: [],
    mcp: [],
    plugins: [],
    workflows: [],
  };
  for (const a of available.agents) {
    if (selected.has(`agent:${a.slug}`)) {
      inv.agents.push(unitRef("agent", a.slug, a.name, a.description));
    }
  }
  for (const s of available.skills) {
    if (selected.has(`skill:${s.slug}:${s.layout}`)) {
      inv.skills.push(unitRef("skill", `${s.slug}:${s.layout}`, s.name, s.description));
    }
  }
  for (const c of available.commands) {
    if (selected.has(`command:${c.slug}`)) {
      inv.commands.push(unitRef("command", c.slug, c.name, c.description));
    }
  }
  for (const h of available.hooks) {
    const k = (h as unknown as { unitKey?: string }).unitKey;
    if (k && selected.has(`hook:${k}`)) {
      inv.hooks.push(unitRef("hook", k, `${h.event}${h.matcher ? ` · ${h.matcher}` : ""}`, h.commands[0]?.command));
    }
  }
  for (const m of available.mcp) {
    if (selected.has(`mcp:${m.name}`)) {
      inv.mcp.push(unitRef("mcp", m.name, m.name, `${m.transport}${m.command ? " · " + m.command : ""}`));
    }
  }
  for (const p of available.plugins) {
    if (selected.has(`plugin:${p.key}`)) {
      inv.plugins.push(
        unitRef("plugin", p.key, p.name, `${p.marketplace || "no marketplace"}${p.installed ? "" : " · not installed at user scope"}`)
      );
    }
  }
  for (const w of available.workflows) {
    const k = workflowKey(w.file);
    if (selected.has(`workflow:${k}`)) {
      inv.workflows.push(
        unitRef("workflow", k, w.name ?? k, w.triggers.join(", ") || undefined)
      );
    }
  }
  return inv;
}

function unitRef(kind: UnitKind, key: string, name?: string, description?: string): TemplateUnitRef {
  return { kind, key, name, description };
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  zIndex: 100,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "20px",
};

const modal: React.CSSProperties = {
  background: "var(--bg-elevated, var(--bg-surface))",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  width: "min(620px, 100%)",
  maxHeight: "90vh",
  overflowY: "auto",
  padding: "20px",
  boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
  fontFamily: "var(--font-body)",
};

const inlineCode: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.78rem",
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "3px",
  padding: "1px 4px",
};

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "3px",
};

const subLabel: React.CSSProperties = {
  fontSize: "0.62rem",
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "5px 8px",
  fontSize: "0.78rem",
  fontFamily: "var(--font-body)",
  background: "var(--bg-surface)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  boxSizing: "border-box",
};

const miniButton: React.CSSProperties = {
  fontSize: "0.65rem",
  padding: "2px 7px",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  background: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer",
};

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: "5px 12px",
    fontSize: "0.74rem",
    fontFamily: "var(--font-body)",
    background: "var(--accent)",
    color: "var(--bg-primary, white)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

function secondaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: "5px 12px",
    fontSize: "0.74rem",
    fontFamily: "var(--font-body)",
    background: "transparent",
    color: "var(--text-primary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}
