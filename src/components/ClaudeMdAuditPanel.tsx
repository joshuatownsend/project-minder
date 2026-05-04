"use client";

import type { ClaudeMdAuditInfo, ClaudeMdAuditFinding, AuditFindingSeverity } from "@/lib/types";

interface Props {
  audit: ClaudeMdAuditInfo;
}

const SEVERITY_LABEL: Record<AuditFindingSeverity, string> = {
  P0: "Highest priority",
  P1: "High priority",
  P2: "Medium priority",
};

function scoreColors(score: number) {
  if (score >= 80) {
    return {
      text: "var(--status-active-text)",
      bg: "var(--status-active-bg)",
      border: "var(--status-active-border)",
    };
  }
  if (score >= 60) {
    return {
      text: "var(--info)",
      bg: "var(--info-bg)",
      border: "var(--info-border)",
    };
  }
  if (score >= 40) {
    return {
      text: "var(--accent)",
      bg: "var(--accent-bg)",
      border: "var(--accent-border)",
    };
  }
  return {
    text: "var(--status-error-text)",
    bg: "var(--status-error-bg)",
    border: "var(--status-error-border)",
  };
}

export function ClaudeMdHealthBadge({ score, hasClaudeMd, compact }: { score: number; hasClaudeMd: boolean; compact?: boolean }) {
  if (!hasClaudeMd) {
    return (
      <span
        title="No CLAUDE.md found"
        style={{
          display: "inline-flex", alignItems: "center", gap: "4px",
          fontSize: compact ? "0.6rem" : "0.66rem",
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "3px",
          padding: "1px 5px",
          letterSpacing: "0.04em",
        }}
      >
        no CLAUDE.md
      </span>
    );
  }
  const c = scoreColors(score);
  return (
    <span
      title={`CLAUDE.md health score: ${score}/100`}
      style={{
        display: "inline-flex", alignItems: "center", gap: "4px",
        fontSize: compact ? "0.6rem" : "0.66rem",
        fontFamily: "var(--font-mono)",
        color: c.text,
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: "3px",
        padding: "1px 5px",
        letterSpacing: "0.04em",
      }}
    >
      ctx {score}
    </span>
  );
}

export function ClaudeMdAuditPanel({ audit }: Props) {
  if (!audit.hasClaudeMd) {
    return (
      <div style={{
        padding: "16px", borderRadius: "var(--radius)",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
      }}>
        <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", margin: 0 }}>
          No CLAUDE.md found in this project. Adding one helps Claude Code understand the
          project&apos;s stack, conventions, and house rules.
        </p>
      </div>
    );
  }

  const c = scoreColors(audit.score);
  const grouped: Record<AuditFindingSeverity, ClaudeMdAuditFinding[]> = { P0: [], P1: [], P2: [] };
  for (const f of audit.findings) grouped[f.severity].push(f);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Score header */}
      <div style={{
        display: "flex", alignItems: "center", gap: "16px",
        padding: "16px 20px",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
      }}>
        <div style={{
          width: "64px", height: "64px",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "1.4rem", fontWeight: 700,
          color: c.text,
          background: c.bg,
          border: `2px solid ${c.border}`,
          borderRadius: "var(--radius)",
          fontFamily: "var(--font-mono)",
        }}>
          {audit.score}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
          <div style={{
            fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.1em",
            textTransform: "uppercase", color: "var(--text-muted)",
            fontFamily: "var(--font-body)",
          }}>
            CLAUDE.md health
          </div>
          <div style={{
            fontSize: "0.78rem", color: "var(--text-secondary)",
            fontFamily: "var(--font-body)",
          }}>
            {audit.totalLines} loaded lines · {audit.importCount} @import{audit.importCount === 1 ? "" : "s"} · {(audit.fileBytes / 1024).toFixed(1)} KB · {audit.rulesFileCount} rules file{audit.rulesFileCount === 1 ? "" : "s"} ({audit.rulesLines} lines)
          </div>
          {audit.totalLines > audit.visibleLines && (
            <div style={{
              fontSize: "0.7rem", color: "var(--accent)",
              fontFamily: "var(--font-body)",
            }}>
              Only the first {audit.visibleLines} of {audit.totalLines} lines are loaded — Claude Code truncates at 200.
            </div>
          )}
        </div>
      </div>

      {/* Findings */}
      {audit.findings.length === 0 ? (
        <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", margin: 0 }}>
          No structural issues detected.
        </p>
      ) : (
        (["P0", "P1", "P2"] as AuditFindingSeverity[]).map((sev) => {
          if (grouped[sev].length === 0) return null;
          return (
            <div key={sev} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{
                fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.1em",
                textTransform: "uppercase", color: "var(--text-muted)",
                fontFamily: "var(--font-body)",
              }}>
                {sev} — {SEVERITY_LABEL[sev]}
              </div>
              {grouped[sev].map((f) => (
                <div
                  key={f.code}
                  style={{
                    padding: "10px 14px",
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius)",
                    display: "flex", flexDirection: "column", gap: "4px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{
                      fontSize: "0.78rem", fontWeight: 500,
                      color: "var(--text-primary)", fontFamily: "var(--font-body)",
                    }}>
                      {f.title}
                    </span>
                    {f.penalty > 0 && (
                      <span style={{
                        marginLeft: "auto",
                        fontSize: "0.65rem", fontFamily: "var(--font-mono)",
                        color: "var(--accent)",
                      }}>
                        −{f.penalty}
                      </span>
                    )}
                  </div>
                  <span style={{
                    fontSize: "0.72rem", color: "var(--text-muted)",
                    fontFamily: "var(--font-body)",
                  }}>
                    {f.fix}
                  </span>
                </div>
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}
