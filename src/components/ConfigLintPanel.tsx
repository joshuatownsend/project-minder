"use client";

import type { LintReport, LintFinding, LintTarget, AuditFindingSeverity } from "@/lib/types";
import { pluralize } from "@/lib/utils";
import { FindingCard } from "./ui/FindingCard";
import { severityTokens, type SeverityTone } from "./ui/design";

interface Props {
  report: LintReport;
}

const TARGET_LABEL: Record<LintTarget, string> = {
  "claude-md": "CLAUDE.md",
  skill: "Skills",
  agent: "Agents",
  command: "Commands",
  settings: "Settings",
  hook: "Hooks",
  mcp: "MCP Servers",
  plugin: "Plugins",
  "output-style": "Output Styles",
  lsp: "LSP Config",
};

const TARGET_ORDER: LintTarget[] = [
  "claude-md", "skill", "agent", "command",
  "settings", "hook", "mcp", "plugin", "output-style", "lsp",
];

const SEVERITY_ORDER: AuditFindingSeverity[] = ["P0", "P1", "P2"];

const TONE: Record<AuditFindingSeverity, SeverityTone> = {
  P0: "crit",
  P1: "high",
  P2: "med",
};

const SEVERITY_CHIP_COLORS: Record<AuditFindingSeverity, { bg: string; text: string }> = {
  P0: { bg: "rgba(239,68,68,0.12)", text: severityTokens.crit.text },
  P1: { bg: "rgba(245,158,11,0.12)", text: severityTokens.high.text },
  P2: { bg: "rgba(99,102,241,0.10)", text: "var(--text-secondary)" },
};

function SeverityChip({ sev, count }: { sev: AuditFindingSeverity; count: number }) {
  const c = SEVERITY_CHIP_COLORS[sev];
  return (
    <span
      style={{
        padding: "1px 6px",
        borderRadius: "var(--radius-sm)",
        background: c.bg,
        color: c.text,
        fontFamily: "var(--font-mono)",
        fontSize: "0.62rem",
        fontWeight: 600,
        letterSpacing: "0.04em",
      }}
    >
      {sev} {count}
    </span>
  );
}

function TargetGroup({ target, findings }: { target: LintTarget; findings: LintFinding[] }) {
  const countsBySev = SEVERITY_ORDER.map((s) => ({
    sev: s,
    count: findings.filter((f) => f.severity === s).length,
  })).filter((x) => x.count > 0);

  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            fontWeight: 600,
            color: "var(--text-primary)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {TARGET_LABEL[target]}
        </span>
        {countsBySev.map(({ sev, count }) => (
          <SeverityChip key={sev} sev={sev} count={count} />
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {sorted.map((f, i) => (
          <FindingCard
            key={`${f.code}-${f.file ?? ""}-${i}`}
            tone={TONE[f.severity]}
            toneLabel={f.severity}
            tag={f.code}
            rightSlot={f.engine}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <span
                style={{
                  fontSize: "0.82rem",
                  fontWeight: 500,
                  color: "var(--text-primary)",
                  lineHeight: 1.4,
                }}
              >
                {f.title}
              </span>
              {f.fix && (
                <span
                  style={{
                    fontSize: "0.78rem",
                    color: "var(--text-secondary)",
                    lineHeight: 1.4,
                  }}
                >
                  {f.fix}
                </span>
              )}
              {(f.file || f.docsUrl) && (
                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                  {f.file && (
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.65rem",
                        color: "var(--text-muted)",
                      }}
                    >
                      {f.file}
                    </span>
                  )}
                  {f.docsUrl && (
                    <a
                      href={f.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.65rem",
                        color: "var(--text-accent)",
                        textDecoration: "none",
                      }}
                    >
                      docs ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          </FindingCard>
        ))}
      </div>
    </div>
  );
}

export function ConfigLintPanel({ report }: Props) {
  const { findings, totalCounts, engineErrors } = report;

  const byTarget = new Map<LintTarget, LintFinding[]>();
  for (const f of findings) {
    const arr = byTarget.get(f.target) ?? [];
    arr.push(f);
    byTarget.set(f.target, arr);
  }

  const activeTargets = TARGET_ORDER.filter((t) => (byTarget.get(t)?.length ?? 0) > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "10px 14px",
          background: "var(--card-bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
        }}
      >
        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginRight: "4px" }}>
          Config lint findings
        </span>
        {SEVERITY_ORDER.map((sev) => (
          <SeverityChip key={sev} sev={sev} count={totalCounts[sev]} />
        ))}
        <span
          style={{
            marginLeft: "auto",
            fontSize: "0.72rem",
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
          }}
        >
          {pluralize(findings.length, "finding")} across{" "}
          {pluralize(activeTargets.length, "surface")}
        </span>
      </div>

      {activeTargets.length === 0 ? (
        <p style={{ fontSize: "0.82rem", color: "var(--text-muted)", margin: 0 }}>
          No findings — all config surfaces are clean.
        </p>
      ) : (
        activeTargets.map((target) => (
          <TargetGroup key={target} target={target} findings={byTarget.get(target)!} />
        ))
      )}

      {/* always rendered when present so "no findings" ≠ "engine broken" */}
      {engineErrors.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.7rem",
              fontWeight: 600,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Engine errors
          </span>
          {engineErrors.map((e, i) => (
            <div
              key={i}
              style={{
                padding: "8px 12px",
                background: "rgba(239,68,68,0.06)",
                border: "1px solid rgba(239,68,68,0.18)",
                borderRadius: "var(--radius)",
                fontSize: "0.78rem",
                color: "var(--text-secondary)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <span style={{ color: severityTokens.crit.text, fontWeight: 600 }}>
                [{e.engine}{e.target ? `/${e.target}` : ""}]
              </span>{" "}
              {e.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
