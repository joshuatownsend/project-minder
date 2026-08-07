"use client";

import { useReportFetch } from "@/hooks/useReportFetch";
import { Skeleton } from "@/components/ui/skeleton";
import { SampleBadge } from "./SampleBadge";
import { defaultSince } from "@/lib/format";
import {
  describeDenialRate,
  anyDenialOutcomeMeasured,
  NO_OUTCOME_FOOTNOTE,
} from "@/lib/telemetry/denialDisplay";
import type { DenialBreakdown } from "@/lib/data/denialAnalyticsFromDb";

interface Props {
  since?: string;
}

/**
 * What each denial kind means, in the terms that decide whether you act on it.
 *
 * `user-rejected` is deliberately separated from the rule-driven kinds: one is
 * configuration you can change, the other is you disagreeing with the model.
 * Claude Code 2.1.216 had to fix its own telemetry for conflating them.
 */
const KIND_META: Record<string, { label: string; explanation: string }> = {
  "permission-rule": {
    label: "permission rule",
    explanation: "Refused by a rule in your settings — configuration you can change.",
  },
  "automode-blocked": {
    label: "auto-mode blocked",
    explanation: "Auto-mode declined the call as too risky to run unattended.",
  },
  "automode-unavailable": {
    label: "auto-mode unavailable",
    explanation: "Auto-mode could not evaluate the call, so it was not run.",
  },
  "user-rejected": {
    label: "you rejected",
    explanation: "You declined the call at the prompt — a judgement, not a rule.",
  },
};

const CELL = { fontFamily: "var(--font-mono)", fontSize: "0.68rem" } as const;

export function DenialBreakdownCard({ since }: Props) {
  const sinceParam = since ?? defaultSince();
  const { data, loading, error } = useReportFetch<DenialBreakdown>(
    `/api/telemetry/denials?since=${encodeURIComponent(sinceParam)}`,
  );

  if (loading) return <Skeleton className="h-32" />;

  if (error) {
    return (
      <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem" }}>
        Error: {error}
      </div>
    );
  }

  // Deliberately NOT phrased as "no denials — all clear". `hasData: false`
  // cannot distinguish "nothing was ever refused" from "this index predates
  // the `denial_kind` column", and the type says so explicitly. Reporting the
  // absence as a clean bill of health would be a claim the data cannot support.
  if (!data?.hasData) {
    return (
      <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem", lineHeight: 1.6 }}>
        No denials recorded in this window.
        <br />
        <span style={{ fontSize: "0.72rem" }}>
          That may mean nothing was refused, or that these sessions predate the
          field — the two are indistinguishable here.
        </span>
      </div>
    );
  }

  const maxDenials = Math.max(...data.kinds.map((k) => k.denials), 1);
  // All-or-nothing: when no kind has a measurable outcome the column is dropped
  // entirely and explained once below, rather than repeating a placeholder on
  // every row. A dash per row reads as "still measuring"; the footnote says
  // what is actually true.
  const showOutcomes = anyDenialOutcomeMeasured(data.kinds);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {data.kinds.map((k) => {
        const meta = KIND_META[k.kind];
        const outcome = describeDenialRate(k);

        return (
          <div key={k.kind} style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
              <span className="sr-only">
                {meta?.explanation ?? `Denial kind: ${k.kind}`}
              </span>
              <span
                aria-hidden="true"
                title={meta?.explanation}
                style={{ ...CELL, color: "var(--text-secondary)", cursor: meta ? "help" : undefined }}
              >
                {meta?.label ?? k.kind}
              </span>
              <span style={{ ...CELL, fontSize: "0.62rem", color: "var(--text-muted)" }}>
                {k.denials} in {k.sessions} {k.sessions === 1 ? "session" : "sessions"}
              </span>
              {/* The question the cross answers: does being refused this way
                  actually derail the work, or does the model route around it?
                  A kind with many denials and an unchanged first-pass rate is
                  friction; one that tanks the rate is a rule worth revisiting. */}
              {showOutcomes && (
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px" }}>
                  {outcome && (
                    <>
                      <span
                        style={{ ...CELL, fontSize: "0.65rem", color: "var(--text-secondary)" }}
                        title={outcome.title}
                      >
                        {outcome.text}
                      </span>
                      <SampleBadge n={outcome.sample} />
                    </>
                  )}
                </div>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div style={{
                height: "4px",
                width: `${Math.round((k.denials / maxDenials) * 70)}px`,
                background: k.kind === "user-rejected" ? "var(--text-muted)" : "var(--accent)",
                borderRadius: "2px",
                minWidth: "2px",
              }} />
              <span style={{ ...CELL, fontSize: "0.6rem", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {k.topTools.slice(0, 3).map((t) => `${t.tool} ×${t.denials}`).join(" · ")}
              </span>
            </div>
          </div>
        );
      })}
      <div style={{ ...CELL, fontSize: "0.6rem", color: "var(--text-muted)", marginTop: "2px", lineHeight: 1.5 }}>
        {data.totalDenials} denied {data.totalDenials === 1 ? "call" : "calls"}
        {!showOutcomes && <> · {NO_OUTCOME_FOOTNOTE}</>}
      </div>
    </div>
  );
}
