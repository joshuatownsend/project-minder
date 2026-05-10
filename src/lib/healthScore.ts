/**
 * Configuration health score for the Home page gauge.
 *
 * Earlier versions of the gauge were a generic "stuff to do" counter that
 * combined insights, manual steps, and approvals into one ratio. That
 * surfaced user task backlog rather than environment health, so a freshly
 * configured Claude Code setup with an unread INSIGHTS.md would look
 * "unhealthy" even though everything was actually working fine.
 *
 * This module replaces that with a weighted roll-up of signals that
 * actually reflect Claude Code environment health: per-project efficiency
 * grades, cache utilization, MCP security findings, pending approvals,
 * telemetry pressure (errors / retries / compactions), and edit
 * acceptance rate.
 *
 * Each component contributes a 0–100 sub-score and a weight. Components
 * that don't have enough data to score (e.g., no cache telemetry yet,
 * no graded projects) are dropped from the calculation and the remaining
 * weights are renormalized — so a brand-new install reports a health
 * score derived from whichever signals it does have, not "0 because no
 * data" or "100 because no problems detected".
 */
import type { EfficiencyGrade } from "./efficiencyGradeCache";

export type HealthLetter = "A" | "B" | "C" | "D" | "F";

export interface HealthComponent {
  /** Stable id so the UI can render component-specific affordances. */
  id:
    | "project-grades"
    | "cache-efficiency"
    | "mcp-security"
    | "approvals"
    | "pressure"
    | "edit-acceptance";
  /** Human-readable label for the breakdown row. */
  label: string;
  /** Relative weight before normalization. */
  weight: number;
  /** 0–100 sub-score, or null when there is not enough data to score. */
  score: number | null;
  /** One-line explanation of what the score reflects (shown as a tooltip / sub). */
  detail: string;
}

export interface HealthInputs {
  /** Per-project efficiency grades. Empty object/array → component dropped. */
  grades: Record<string, EfficiencyGrade>;
  /** Cache hit rate from the last 7 days, 0–1. null when no telemetry. */
  cacheHitRate: number | null;
  /** MCP security findings broken out by severity bucket. */
  mcpFindings: { crit: number; high: number; med: number; low: number; info: number };
  /** True when an MCP scan has run; false → component dropped. */
  mcpScanned: boolean;
  /** Pending approvals count from pulse. */
  approvals: number;
  /** Telemetry pressure signals from getPressureSnapshot. */
  pressure: { retryExhaustion: number; compactions: number; hasData: boolean };
  /** Edit acceptance: rate (0–1) and sample size. Need ≥10 samples to score. */
  editAcceptance: { rate: number; n: number; hasData: boolean };
}

export interface HealthReport {
  /** Weighted overall score, 0–100. */
  score: number;
  /** Letter grade derived from `score`. */
  grade: HealthLetter;
  /** Each component, including dropped ones (with score=null). */
  components: HealthComponent[];
  /** True when at least one component contributed to the score. */
  hasData: boolean;
}

const GRADE_TO_NUM: Record<EfficiencyGrade, number> = {
  A: 95, B: 85, C: 70, D: 50, F: 20,
};

const SEVERITY_WEIGHT = { crit: 10, high: 5, med: 2, low: 0.5, info: 0 };

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function letterFor(score: number): HealthLetter {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export function computeHealthScore(input: HealthInputs): HealthReport {
  const components: HealthComponent[] = [];

  // 1. Project grades — 30%. Average the per-project grade numbers.
  {
    const values = Object.values(input.grades);
    if (values.length === 0) {
      components.push({
        id: "project-grades",
        label: "Project grades",
        weight: 30,
        score: null,
        detail: "No graded projects yet",
      });
    } else {
      const avg = values.reduce((s, g) => s + GRADE_TO_NUM[g], 0) / values.length;
      const counts = values.reduce<Record<EfficiencyGrade, number>>(
        (acc, g) => ({ ...acc, [g]: (acc[g] ?? 0) + 1 }),
        { A: 0, B: 0, C: 0, D: 0, F: 0 },
      );
      const detail = (["A", "B", "C", "D", "F"] as const)
        .filter((g) => counts[g] > 0)
        .map((g) => `${counts[g]}${g}`)
        .join(" · ");
      components.push({
        id: "project-grades",
        label: "Project grades",
        weight: 30,
        score: Math.round(avg),
        detail: `${values.length} graded — ${detail}`,
      });
    }
  }

  // 2. Cache efficiency — 20%. hitRate is bounded [0, 1] in the new formula
  //    (cacheRead / total token flow). Direct linear mapping to 0–100.
  {
    if (input.cacheHitRate === null) {
      components.push({
        id: "cache-efficiency",
        label: "Cache efficiency",
        weight: 20,
        score: null,
        detail: "No telemetry yet",
      });
    } else {
      const score = Math.round(clamp(input.cacheHitRate * 100, 0, 100));
      components.push({
        id: "cache-efficiency",
        label: "Cache efficiency",
        weight: 20,
        score,
        detail: `${score}% cache hit rate (7d)`,
      });
    }
  }

  // 3. MCP security — 20%. Sum severity-weighted finding count. 5 points off
  //    per weight-unit, so a single critical finding (weight 10) drops the
  //    sub-score to 50; a clean scan stays at 100.
  {
    if (!input.mcpScanned) {
      components.push({
        id: "mcp-security",
        label: "MCP security",
        weight: 20,
        score: null,
        detail: "Run /api/mcp-security/findings?refresh=1",
      });
    } else {
      const f = input.mcpFindings;
      const weighted =
        f.crit * SEVERITY_WEIGHT.crit +
        f.high * SEVERITY_WEIGHT.high +
        f.med  * SEVERITY_WEIGHT.med  +
        f.low  * SEVERITY_WEIGHT.low;
      const score = Math.round(clamp(100 - weighted * 5, 0, 100));
      const totalCount = f.crit + f.high + f.med + f.low + f.info;
      const detail = totalCount === 0
        ? "Clean — no findings"
        : [
            f.crit > 0 && `${f.crit} crit`,
            f.high > 0 && `${f.high} high`,
            f.med  > 0 && `${f.med} med`,
            f.low  > 0 && `${f.low} low`,
          ].filter(Boolean).join(" · ");
      components.push({
        id: "mcp-security",
        label: "MCP security",
        weight: 20,
        score,
        detail,
      });
    }
  }

  // 4. Pending approvals — 10%. Each pending approval drops the sub-score
  //    by 10. Pending approvals block in-flight work, so they're heavier
  //    per-unit than the other "things to fix" categories.
  {
    const score = Math.round(clamp(100 - input.approvals * 10, 0, 100));
    components.push({
      id: "approvals",
      label: "Approvals",
      weight: 10,
      score,
      detail: input.approvals === 0 ? "No pending approvals" : `${input.approvals} pending`,
    });
  }

  // 5. Telemetry pressure — 10%. Only retry-exhaustion meaningfully reflects
  //    config health (rate-limit headroom, network reliability, retry policy).
  //    Compactions are user-behavior signal (long sessions) and we
  //    intentionally don't penalize them — they show up in the detail line
  //    as context but don't move the score.
  {
    if (!input.pressure.hasData) {
      components.push({
        id: "pressure",
        label: "Runtime pressure",
        weight: 10,
        score: null,
        detail: "No telemetry yet",
      });
    } else {
      const { retryExhaustion, compactions } = input.pressure;
      const score = Math.round(clamp(100 - retryExhaustion * 10, 0, 100));
      const parts: string[] = [];
      parts.push(`${retryExhaustion} retry exhaust`);
      if (compactions > 0) parts.push(`${compactions} compactions`);
      const detail = retryExhaustion === 0
        ? compactions === 0 ? "No retries or compactions" : `${compactions} compactions (info only)`
        : parts.join(" · ");
      components.push({
        id: "pressure",
        label: "Runtime pressure",
        weight: 10,
        score,
        detail,
      });
    }
  }

  // 6. Edit acceptance — 10%. Need a minimum sample so a single rejected
  //    edit doesn't tank the score. Below the threshold we drop the
  //    component rather than report a noisy number.
  {
    const { rate, n, hasData } = input.editAcceptance;
    if (!hasData || n < 10) {
      components.push({
        id: "edit-acceptance",
        label: "Edit acceptance",
        weight: 10,
        score: null,
        detail: hasData ? `Need ${10 - n} more samples` : "No edit telemetry yet",
      });
    } else {
      const score = Math.round(clamp(rate * 100, 0, 100));
      components.push({
        id: "edit-acceptance",
        label: "Edit acceptance",
        weight: 10,
        score,
        detail: `${score}% accepted (n=${n})`,
      });
    }
  }

  // Renormalize weights over the components that contributed a score.
  const scored = components.filter((c) => c.score !== null);
  const totalWeight = scored.reduce((s, c) => s + c.weight, 0) || 1;
  const overall = scored.length === 0
    ? 0
    : Math.round(
        scored.reduce((s, c) => s + (c.score ?? 0) * (c.weight / totalWeight), 0),
      );

  return {
    score: overall,
    grade: letterFor(overall),
    components,
    hasData: scored.length > 0,
  };
}
