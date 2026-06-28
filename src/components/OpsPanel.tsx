"use client";

import type {
  ProjectData,
  OpsSummary,
  OpsCron,
  OpsRunbookSection,
  OpsSectionKey,
  HostingTarget,
  DatabaseInfo,
  DependabotUpdate,
} from "@/lib/types";
import { deriveOpsSummary } from "@/lib/ops/summary";
import {
  Cloud,
  Boxes,
  Database as DatabaseIcon,
  Clock,
  Package,
  ClipboardList,
} from "lucide-react";
import { Pill, inlineCode, mutedMono, metaText, fileBasename } from "./config/primitives";

interface Props {
  project: ProjectData;
}

// The five curated runbook facts, in display order. `other` sections render
// after these under their verbatim heading.
const RUNBOOK_SECTIONS: { key: Exclude<OpsSectionKey, "other">; label: string }[] = [
  { key: "backups", label: "Backups" },
  { key: "monitoring", label: "Monitoring & Alerting" },
  { key: "oncall", label: "On-call & Escalation" },
  { key: "secrets", label: "Secrets & Rotation" },
  { key: "restore", label: "Restore & Recovery" },
];

export function OpsPanel({ project }: Props) {
  const ops = deriveOpsSummary(project);
  const captured = ops.coverage.autoGroups + ops.coverage.curatedSections;
  const total = 4 + ops.coverage.curatedTotal; // 4 auto groups + 5 curated facts

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {/* Coverage nudge */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "6px 0 2px",
          fontSize: "0.68rem",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>
          {captured} of {total} operational facts captured
        </span>
      </div>

      {/* ── Auto-detected ───────────────────────────────────────────────── */}
      {ops.deployTargets.length > 0 && (
        <Section icon={<Cloud style={iconStyle} />} label="Deploy targets" count={ops.deployTargets.length}>
          {ops.deployTargets.map((t) => (
            <DeployRow key={`${t.platform}:${t.sourcePath}`} target={t} />
          ))}
        </Section>
      )}

      {ops.services.length > 0 && (
        <Section icon={<Boxes style={iconStyle} />} label="Services" count={ops.services.length}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", padding: "7px 0" }}>
            {ops.services.map((s) => (
              <Pill key={s} tone="info">
                {s}
              </Pill>
            ))}
          </div>
        </Section>
      )}

      {ops.database && (
        <Section icon={<DatabaseIcon style={iconStyle} />} label="Database" count={1}>
          <DatabaseRow database={ops.database} />
        </Section>
      )}

      {ops.crons.length > 0 && (
        <Section icon={<Clock style={iconStyle} />} label="Schedules" count={ops.crons.length}>
          {ops.crons.map((c, i) => (
            <CronRow key={`${c.source}:${c.sourcePath}:${i}`} cron={c} />
          ))}
        </Section>
      )}

      {ops.dependabot.length > 0 && (
        <Section icon={<Package style={iconStyle} />} label="Dependency updates" count={ops.dependabot.length}>
          {ops.dependabot.map((d, i) => (
            <DependabotRow key={`${d.ecosystem}:${i}`} update={d} />
          ))}
        </Section>
      )}

      {/* ── Curated runbook (OPERATIONS.md) ─────────────────────────────── */}
      <Section
        icon={<ClipboardList style={iconStyle} />}
        label="Runbook"
        count={ops.runbook?.sections.length ?? 0}
      >
        {RUNBOOK_SECTIONS.map(({ key, label }) => {
          const section = ops.runbook?.sections.find((s) => s.key === key);
          return section ? (
            <RunbookSectionBlock key={key} label={label} section={section} />
          ) : (
            <MissingSectionRow key={key} label={label} />
          );
        })}
        {/* Pass-through `other` sections, kept verbatim. */}
        {ops.runbook?.sections
          .filter((s) => s.key === "other")
          .map((s) => (
            <RunbookSectionBlock key={`other:${s.line}`} label={s.heading} section={s} />
          ))}
      </Section>
    </div>
  );
}

// ─── Auto-detected rows ──────────────────────────────────────────────────────

function DeployRow({ target }: { target: HostingTarget }) {
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
            <span style={{ color: "var(--text-secondary)" }}>{detailLines.join(" · ")}</span>
          )}
        </span>
      }
      right={null}
    />
  );
}

function DatabaseRow({ database }: { database: DatabaseInfo }) {
  return (
    <Row
      left={<Pill tone="info">{database.type}</Pill>}
      middle={
        <span style={metaText}>
          <code style={inlineCode}>
            {database.host}
            {database.port ? `:${database.port}` : ""}
          </code>
          {database.name && <span style={{ color: "var(--text-secondary)" }}>{database.name}</span>}
        </span>
      }
      right={database.provider ? <Pill>{database.provider}</Pill> : null}
    />
  );
}

function CronRow({ cron }: { cron: OpsCron }) {
  return (
    <Row
      left={<Pill tone="info">cron</Pill>}
      middle={
        <span style={metaText}>
          <code style={inlineCode}>{cron.schedule}</code>
          {cron.path && <span style={{ color: "var(--text-secondary)" }}>{cron.path}</span>}
        </span>
      }
      right={<span style={mutedMono}>{cron.source}</span>}
    />
  );
}

function DependabotRow({ update }: { update: DependabotUpdate }) {
  return (
    <Row
      left={<Pill>{update.ecosystem}</Pill>}
      middle={
        update.directory ? (
          <span style={metaText}>
            <code style={inlineCode}>{update.directory}</code>
          </span>
        ) : (
          <span />
        )
      }
      right={update.schedule ? <span style={mutedMono}>{update.schedule}</span> : null}
    />
  );
}

// ─── Runbook rows ────────────────────────────────────────────────────────────

function RunbookSectionBlock({ label, section }: { label: string; section: OpsRunbookSection }) {
  return (
    <div style={{ padding: "7px 0", borderBottom: "1px solid var(--border-subtle)" }}>
      <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-primary)" }}>{label}</div>
      {section.body && (
        <p style={{ margin: "3px 0 0", fontSize: "0.72rem", color: "var(--text-secondary)", whiteSpace: "pre-line" }}>
          {section.body}
        </p>
      )}
      {section.items.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginTop: "4px" }}>
          {section.items.map((it) => (
            <div key={it.lineNumber} style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
              <span style={{ ...mutedMono, flexShrink: 0 }}>{it.done ? "[x]" : "[ ]"}</span>
              <span
                style={{
                  fontSize: "0.74rem",
                  color: it.done ? "var(--text-muted)" : "var(--text-primary)",
                  textDecoration: it.done ? "line-through" : "none",
                }}
              >
                {it.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MissingSectionRow({ label }: { label: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "7px 0",
        borderBottom: "1px solid var(--border-subtle)",
        opacity: 0.7,
      }}
    >
      <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{label}</span>
      <span style={mutedMono}>
        not documented — add to <code style={inlineCode}>OPERATIONS.md</code>
      </span>
    </div>
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
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
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
