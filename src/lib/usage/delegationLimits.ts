/**
 * C2 — runaway-delegation guardrails.
 *
 * Claude Code 2.1.212/217 introduced hard caps on delegation. They are a
 * genuinely new failure mode: a session can now be *silently truncated* by a
 * cap rather than finishing. Nothing in the transcript says "I stopped because
 * I ran out of subagents" — the work simply stops, and the session reads like
 * one that chose to finish.
 *
 * Pure functions over already-computed counts: no FS, no DB, no scan. Both
 * backends produce the inputs, so this layer cannot make them disagree.
 */

/**
 * The documented ceilings. Values Claude Code enforces, not Minder's opinion —
 * `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` and `--max-budget-usd` make two of
 * them configurable, so a machine that has raised them will show a session
 * "over" a cap that was never enforced there. That is why a reading at or above
 * a cap is reported as *reached*, never as *blocked*: Minder can see the count,
 * not the ceiling that was actually in force.
 */
export const DELEGATION_CAPS = {
  /** Subagent spawns per session. */
  spawns: 200,
  /** Web searches per session. */
  webSearches: 200,
  /** Concurrent subagents (configurable via CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS). */
  concurrent: 20,
  /** Nesting depth of spawned agents. */
  depth: 3,
} as const;

export type DelegationLimitKey = keyof typeof DELEGATION_CAPS;

/** Fraction of a cap at which a session is worth flagging before it lands. */
export const APPROACHING_RATIO = 0.8;

export type DelegationSeverity = "ok" | "approaching" | "reached";

export interface DelegationUsage {
  /** Subagent spawns observed. */
  spawns?: number;
  /** Web searches/fetches observed. */
  webSearches?: number;
  /**
   * Claude Code version that recorded the session. Caps introduced after it are
   * reported unmeasured rather than compared. Absent means "cannot tell", which
   * suppresses every cap — see `capApplies`.
   */
  cliVersion?: string;
}

export interface DelegationLimitStatus {
  key: DelegationLimitKey;
  /** Observed count, or undefined when Minder cannot measure this limit. */
  count?: number;
  cap: number;
  severity: DelegationSeverity;
  /** `count / cap`, undefined when unmeasured. */
  ratio?: number;
}

export interface DelegationAssessment {
  limits: DelegationLimitStatus[];
  /** The worst severity across measured limits. */
  worst: DelegationSeverity;
  /** True when at least one limit could be measured at all. */
  hasData: boolean;
}

/**
 * Claude Code version that introduced each cap.
 *
 * A session recorded before its cap existed was not constrained by it, so
 * comparing its counts against that cap invents a limit retroactively — and the
 * badge does not merely mis-sort, it claims the session "may have been silently
 * truncated", which for a 2026-era transcript with 160 spawns is a factual
 * assertion about something that never happened (Codex review, #388).
 */
export const CAP_INTRODUCED_IN: Record<DelegationLimitKey, string> = {
  spawns: "2.1.212",
  webSearches: "2.1.217",
  concurrent: "2.1.212",
  depth: "2.1.212",
};

/** `a >= b` over dotted numeric versions. Missing segments read as 0. */
function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * Whether a cap can be assessed for a session recorded by `cliVersion`.
 *
 * An unknown version yields FALSE — the same "unmeasured is not zero" rule the
 * rest of this module runs on. Minder cannot tell whether the cap applied, and
 * asserting it did is the error that actually misleads; staying quiet only
 * costs a badge on sessions whose version was never recorded.
 */
export function capApplies(key: DelegationLimitKey, cliVersion?: string): boolean {
  if (!cliVersion) return false;
  return versionAtLeast(cliVersion, CAP_INTRODUCED_IN[key]);
}

function severityFor(count: number, cap: number): DelegationSeverity {
  if (count >= cap) return "reached";
  if (count >= cap * APPROACHING_RATIO) return "approaching";
  return "ok";
}

const SEVERITY_ORDER: Record<DelegationSeverity, number> = {
  ok: 0,
  approaching: 1,
  reached: 2,
};

/**
 * Assess one session's delegation counts against the caps.
 *
 * **Unmeasured is not zero.** `concurrent` and `depth` are reported with no
 * count: concurrency is an instantaneous property that a finished transcript
 * cannot recover, and depth needs parent-to-child linkage between spawns.
 * Minder stores `turns.parent_tool_use_id` for exactly that, and it is NULL on
 * every row of the reference index — the plan assumed subagent trees were
 * already reconstructible; they are not, on this data. Reporting those two as
 * `0` would render a session that nested five deep as comfortably within a cap
 * of three, which is worse than admitting the gap.
 */
export function assessDelegation(usage: DelegationUsage): DelegationAssessment {
  const limits: DelegationLimitStatus[] = [];

  // A cap that did not exist when the session ran is reported unmeasured, not
  // compared — same treatment as a count Minder cannot recover, because the
  // honest answer is identical: this limit says nothing about this session.
  const measured: Array<[DelegationLimitKey, number | undefined]> = [
    ["spawns", capApplies("spawns", usage.cliVersion) ? usage.spawns : undefined],
    [
      "webSearches",
      capApplies("webSearches", usage.cliVersion) ? usage.webSearches : undefined,
    ],
    // Deliberately unmeasurable today — see the docstring.
    ["concurrent", undefined],
    ["depth", undefined],
  ];

  for (const [key, count] of measured) {
    const cap = DELEGATION_CAPS[key];
    if (count === undefined) {
      limits.push({ key, cap, severity: "ok", count: undefined, ratio: undefined });
      continue;
    }
    limits.push({
      key,
      count,
      cap,
      ratio: cap > 0 ? count / cap : undefined,
      severity: severityFor(count, cap),
    });
  }

  const measuredLimits = limits.filter((l) => l.count !== undefined);
  const worst = measuredLimits.reduce<DelegationSeverity>(
    (acc, l) => (SEVERITY_ORDER[l.severity] > SEVERITY_ORDER[acc] ? l.severity : acc),
    "ok"
  );

  return { limits, worst, hasData: measuredLimits.length > 0 };
}

/**
 * Short label for a badge, or undefined when there is nothing worth showing.
 *
 * Returns undefined for `ok` on purpose: a badge on every session that used a
 * handful of subagents is noise, and noise is how a real one gets missed.
 */
export function delegationBadgeLabel(assessment: DelegationAssessment): string | undefined {
  if (!assessment.hasData || assessment.worst === "ok") return undefined;
  const worstLimit = assessment.limits
    .filter((l) => l.count !== undefined && l.severity === assessment.worst)
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))[0];
  if (!worstLimit) return undefined;
  const noun = worstLimit.key === "spawns" ? "subagents" : "web searches";
  return assessment.worst === "reached"
    ? `${noun} cap reached (${worstLimit.count}/${worstLimit.cap})`
    : `nearing ${noun} cap (${worstLimit.count}/${worstLimit.cap})`;
}
