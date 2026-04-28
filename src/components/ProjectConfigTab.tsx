"use client";

import type {
  CiCdInfo,
  DependabotUpdate,
  HostingTarget,
  HooksInfo,
  McpServersInfo,
  ProjectData,
  VercelCron,
  Workflow,
  WorkflowJob,
} from "@/lib/types";
import { Settings, Webhook, Server, Workflow as WorkflowIcon, Cloud } from "lucide-react";
import {
  Pill,
  inlineCode,
  mutedMono,
  metaText,
  commandPreview,
  fileBasename,
} from "./config/primitives";

interface Props {
  project: ProjectData;
}

export function ProjectConfigTab({ project }: Props) {
  const { hooks, mcpServers, cicd } = project;
  const empty = !hooks && !mcpServers && !cicd;

  if (empty) {
    return (
      <div
        style={{
          padding: "32px 0",
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <Settings style={{ width: "24px", height: "24px", color: "var(--text-muted)", opacity: 0.3 }} />
        <p style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
          No project-local Claude or CI/CD config detected.
        </p>
        <p style={{ fontSize: "0.68rem", color: "var(--text-muted)", margin: 0 }}>
          User-level plugins and hooks live on{" "}
          <a href="/config" style={{ color: "var(--info)" }}>/config</a>.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {hooks && hooks.entries.length > 0 && <HooksSection hooks={hooks} />}
      {mcpServers && mcpServers.servers.length > 0 && <McpSection servers={mcpServers} />}
      {cicd && cicd.workflows.length > 0 && <WorkflowsSection workflows={cicd.workflows} />}
      {cicd && hasHostingOrAutomation(cicd) && <HostingSection cicd={cicd} />}
    </div>
  );
}

function hasHostingOrAutomation(cicd: CiCdInfo): boolean {
  return cicd.hosting.length > 0 || cicd.vercelCrons.length > 0 || cicd.dependabot.length > 0;
}

// ─── Sections ────────────────────────────────────────────────────────────────

function HooksSection({ hooks }: { hooks: HooksInfo }) {
  return (
    <Section icon={<Webhook style={iconStyle} />} label="Hooks" count={hooks.entries.length}>
      {hooks.entries.map((h, i) => (
        <Row
          key={i}
          left={<Pill tone="info">{h.event}</Pill>}
          middle={
            <span style={metaText} title={h.commands.map((c) => c.command).join("\n")}>
              {h.matcher && <code style={inlineCode}>{h.matcher}</code>}
              {h.matcher && h.commands.length > 0 && " · "}
              {commandPreview(h.commands[0]?.command, h.commands.length)}
            </span>
          }
          right={
            <span style={mutedMono}>{h.source === "local" ? "settings.local" : "settings"}</span>
          }
        />
      ))}
    </Section>
  );
}

function McpSection({ servers }: { servers: McpServersInfo }) {
  return (
    <Section icon={<Server style={iconStyle} />} label="MCP Servers" count={servers.servers.length}>
      {servers.servers.map((s) => (
        <Row
          key={s.name}
          left={
            <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-primary)" }}>
              {s.name}
            </span>
          }
          middle={
            <span style={metaText} title={s.command ?? s.url ?? ""}>
              <Pill>{s.transport}</Pill>
              {s.command && <code style={inlineCode}>{s.command}{s.args && s.args.length > 0 ? ` ${s.args.join(" ")}` : ""}</code>}
              {s.url && <code style={inlineCode}>{s.url}</code>}
            </span>
          }
          right={
            s.envKeys && s.envKeys.length > 0 ? (
              <span style={mutedMono} title={`env: ${s.envKeys.join(", ")}`}>
                env {s.envKeys.length}
              </span>
            ) : null
          }
        />
      ))}
    </Section>
  );
}

function WorkflowsSection({ workflows }: { workflows: Workflow[] }) {
  return (
    <Section
      icon={<WorkflowIcon style={iconStyle} />}
      label="GitHub Workflows"
      count={workflows.length}
    >
      {workflows.map((w) => (
        <div
          key={w.file}
          style={{
            padding: "7px 0",
            borderBottom: "1px solid var(--border-subtle)",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-primary)" }}>
              {w.name ?? fileBasename(w.file)}
            </span>
            {!w.parseOk && <Pill tone="warn">parse failed</Pill>}
            {w.triggers.map((t) => (
              <Pill key={t}>{t}</Pill>
            ))}
            {w.cron.map((c) => (
              <code key={c} style={inlineCode}>{c}</code>
            ))}
          </div>
          {w.jobs.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "2px", paddingLeft: "2px" }}>
              {w.jobs.map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </div>
          )}
        </div>
      ))}
    </Section>
  );
}

function JobRow({ job }: { job: WorkflowJob }) {
  const usesText = job.actionUses.length > 0 ? job.actionUses.join(", ") : null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-secondary)" }}>
        {job.name ?? job.id}
      </span>
      {job.runsOn && <span style={mutedMono}>{job.runsOn}</span>}
      {job.uses && <code style={inlineCode}>{job.uses}</code>}
      {usesText && (
        <span style={mutedMono} title={usesText}>
          {job.actionUses.length} action{job.actionUses.length === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

function HostingSection({ cicd }: { cicd: CiCdInfo }) {
  return (
    <Section
      icon={<Cloud style={iconStyle} />}
      label="Hosting & Automation"
      count={cicd.hosting.length + cicd.vercelCrons.length + cicd.dependabot.length}
    >
      {cicd.hosting.map((h) => (
        <HostingRow key={`${h.platform}:${h.sourcePath}`} target={h} />
      ))}
      {cicd.vercelCrons.map((c, i) => (
        <VercelCronRow key={i} cron={c} />
      ))}
      {cicd.dependabot.map((d, i) => (
        <DependabotRow key={i} update={d} />
      ))}
    </Section>
  );
}

function HostingRow({ target }: { target: HostingTarget }) {
  const detailLines = target.detail
    ? Object.entries(target.detail).map(([k, v]) => `${k}=${formatDetailValue(v)}`)
    : [];

  return (
    <Row
      left={<Pill tone="info">{target.platform}</Pill>}
      middle={
        <span style={metaText}>
          <code style={inlineCode}>{fileBasename(target.sourcePath)}</code>
          {detailLines.length > 0 && (
            <span style={{ marginLeft: "6px", color: "var(--text-secondary)" }}>
              {detailLines.join(" · ")}
            </span>
          )}
        </span>
      }
      right={null}
    />
  );
}

function VercelCronRow({ cron }: { cron: VercelCron }) {
  return (
    <Row
      left={<Pill tone="info">cron</Pill>}
      middle={
        <span style={metaText}>
          <code style={inlineCode}>{cron.schedule}</code>
          <span style={{ marginLeft: "6px", color: "var(--text-secondary)" }}>{cron.path}</span>
        </span>
      }
      right={<span style={mutedMono}>vercel.json</span>}
    />
  );
}

function DependabotRow({ update }: { update: DependabotUpdate }) {
  return (
    <Row
      left={<Pill>dependabot</Pill>}
      middle={
        <span style={metaText}>
          <code style={inlineCode}>{update.ecosystem}</code>
          {update.directory && (
            <span style={{ marginLeft: "6px", color: "var(--text-secondary)" }}>{update.directory}</span>
          )}
        </span>
      }
      right={update.schedule ? <span style={mutedMono}>{update.schedule}</span> : null}
    />
  );
}

// ─── Layout primitives ───────────────────────────────────────────────────────

function Section({
  icon,
  label,
  count,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: "16px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: "6px",
          fontSize: "0.6rem",
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
          fontFamily: "var(--font-body)",
        }}
      >
        {icon}
        <span>{label}</span>
        <span style={{ fontWeight: 400 }}>({count})</span>
      </div>
      <div>{children}</div>
    </section>
  );
}

function Row({
  left,
  middle,
  right,
}: {
  left: React.ReactNode;
  middle: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "7px 0",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <span style={{ flexShrink: 0 }}>{left}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {middle}
      </span>
      {right && <span style={{ flexShrink: 0 }}>{right}</span>}
    </div>
  );
}

const iconStyle: React.CSSProperties = {
  width: "12px",
  height: "12px",
  color: "var(--text-muted)",
};

function formatDetailValue(v: string | number | boolean | string[]): string {
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}
