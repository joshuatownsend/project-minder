"use client";

import Link from "next/link";
import type { LintFinding, AuditFindingSeverity } from "@/lib/types";
import { severityTokens } from "./design";

interface LintCountChipProps {
  findings: LintFinding[];
  projectSlug?: string;
}

function highestSeverity(findings: LintFinding[]): AuditFindingSeverity {
  if (findings.some((f) => f.severity === "P0")) return "P0";
  if (findings.some((f) => f.severity === "P1")) return "P1";
  return "P2";
}

const TONE_FOR_SEV = {
  P0: severityTokens.crit,
  P1: severityTokens.high,
  P2: severityTokens.med,
} as const;

export function LintCountChip({ findings, projectSlug }: LintCountChipProps) {
  if (findings.length === 0) return null;

  const sev = highestSeverity(findings);
  const tone = TONE_FOR_SEV[sev];
  const tooltipText = findings.map((f) => f.title).join("\n");

  const chipStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: "0.6rem",
    fontWeight: 700,
    color: tone.text,
    background: tone.bg,
    border: `1px solid ${tone.border}`,
    borderRadius: "3px",
    padding: "1px 5px",
    flexShrink: 0,
    textDecoration: "none",
    lineHeight: 1.4,
    cursor: projectSlug ? "pointer" : "help",
  };

  const label = String(findings.length);

  if (projectSlug) {
    return (
      <Link
        href={`/project/${projectSlug}?tab=config-lint`}
        title={tooltipText}
        style={chipStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {label}
      </Link>
    );
  }

  return (
    <span title={tooltipText} style={chipStyle}>
      {label}
    </span>
  );
}
