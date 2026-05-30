"use client";

import { useState } from "react";
import type {
  LintReport,
  LintFinding,
  LintTarget,
  AuditFindingSeverity,
  FormatFileResult,
} from "@/lib/types";
import { pluralize } from "@/lib/utils";
import { FindingCard } from "./ui/FindingCard";
import { severityTokens, ErrorBanner, type SeverityTone } from "./ui/design";

interface Props {
  report: LintReport;
  /** When provided, enables the formatter control (Check / Apply). Absent in
   *  read-only contexts where the project path can't be resolved. */
  projectSlug?: string;
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

/** Strict-gate state: green PASS when no P0/P1, red FAIL otherwise. Reads the
 *  single authoritative `report.hasBlocking` flag rather than re-deriving. */
function StrictBadge({ hasBlocking }: { hasBlocking: boolean }) {
  const tone = hasBlocking
    ? severityTokens.crit
    : { text: "var(--good)", bg: "var(--good-soft)", border: "var(--good-line)" };
  return (
    <span
      title={
        hasBlocking
          ? "Strict gate: FAIL — at least one P0/P1 finding blocks this config."
          : "Strict gate: PASS — no P0/P1 findings."
      }
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.62rem",
        fontWeight: 700,
        letterSpacing: "0.04em",
        padding: "1px 6px",
        borderRadius: "var(--radius-sm)",
        color: tone.text,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
      }}
    >
      STRICT: {hasBlocking ? "FAIL" : "PASS"}
    </span>
  );
}

type FormatPhase = "idle" | "checking" | "checked" | "applying" | "applied";

/** Formatter control: a non-mutating Check, then an explicit Apply that
 *  backs up each file (revertable from Config History) before rewriting via
 *  `claudelint format`. Apply only ever runs on this button click — never on
 *  scan. */
function FormatterControl({ projectSlug }: { projectSlug: string }) {
  const [phase, setPhase] = useState<FormatPhase>("idle");
  const [files, setFiles] = useState<string[]>([]);
  const [applied, setApplied] = useState<FormatFileResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const endpoint = `/api/config-lint/${projectSlug}/format`;

  // Single owner of the POST + error-extraction; throws on failure so each
  // caller only has to describe its own success/revert transition.
  async function postFormat(mode: "check" | "apply") {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const data = await res.json();
    if (!res.ok || data.engineError) {
      throw new Error(data.error ?? data.engineError ?? `Format ${mode} failed`);
    }
    return data;
  }

  async function runCheck() {
    setPhase("checking");
    setError(null);
    try {
      const data = await postFormat("check");
      setFiles(data.filesNeedingFormat ?? []);
      setPhase("checked");
    } catch (e) {
      setError(String(e));
      setPhase("idle");
    }
  }

  async function runApply() {
    setPhase("applying");
    setError(null);
    try {
      const data = await postFormat("apply");
      setApplied(data.formatted ?? []);
      setPhase("applied");
    } catch (e) {
      setError(String(e));
      setPhase("checked");
    }
  }

  const btnStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: "0.72rem",
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: "var(--radius-sm)",
    background: "var(--card-bg)",
    border: "1px solid var(--border)",
    color: "var(--text-primary)",
    cursor: "pointer",
  };

  const changedCount = applied.filter((f) => f.changed).length;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "10px 14px",
        background: "var(--card-bg)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          Formatter
        </span>
        <button
          type="button"
          onClick={runCheck}
          disabled={phase === "checking" || phase === "applying"}
          style={btnStyle}
        >
          {phase === "checking" ? "Checking…" : "Check formatting"}
        </button>
        {phase === "checked" && files.length > 0 && (
          <button
            type="button"
            onClick={runApply}
            style={{ ...btnStyle, color: severityTokens.high.text, borderColor: severityTokens.high.border }}
          >
            Apply to {pluralize(files.length, "file")}
          </button>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontSize: "0.7rem",
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
          }}
        >
          {phase === "checked" &&
            (files.length === 0 ? "All files formatted ✓" : `${pluralize(files.length, "file")} need formatting`)}
          {phase === "applying" && "Applying…"}
          {phase === "applied" &&
            (changedCount === 0
              ? "No changes were needed ✓"
              : `Formatted ${pluralize(changedCount, "file")} — backed up, revert in Config History`)}
        </span>
      </div>

      {(phase === "checked" && files.length > 0) && (
        <ul style={{ margin: 0, paddingLeft: "18px" }}>
          {files.map((f) => (
            <li key={f} style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-secondary)" }}>
              {f}
            </li>
          ))}
        </ul>
      )}

      {phase === "applied" && changedCount > 0 && (
        <ul style={{ margin: 0, paddingLeft: "18px" }}>
          {applied.filter((f) => f.changed).map((f) => (
            <li key={f.file} style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-secondary)" }}>
              {f.file}
              {f.backupId === null && (
                <span style={{ color: severityTokens.high.text }}> (not backed up)</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <ErrorBanner message={error} />}
    </div>
  );
}

export function ConfigLintPanel({ report, projectSlug }: Props) {
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
        <StrictBadge hasBlocking={report.hasBlocking} />
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

      {projectSlug && <FormatterControl projectSlug={projectSlug} />}

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
