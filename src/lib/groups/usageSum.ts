/**
 * Sum usage reports across a group's locations.
 *
 * Usage is fetched, not scanned, so `aggregateGroup()` cannot total it: it
 * exposes `usageKeys` and leaves the summing to the fetch layer. This is that
 * layer's arithmetic — one `UsageReport` per usage key in, one summary out.
 *
 * Only additive fields are carried. A rate is recomputed from its summed
 * numerator and denominator (`cacheHitRate` uses the aggregator's own A7
 * formula, cache-write tokens in the denominator) and never averaged across
 * reports; fields whose parts are not on the report (`oneShot`, `streak`,
 * per-model `selfCorrectionRate`) are omitted rather than guessed.
 *
 * Client-safe: imports types only.
 */

import type { CategoryType, UsageReport } from "@/lib/usage/types";

export interface GroupModelCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  cost: number;
  turns: number;
}

export interface GroupCategoryCost {
  category: CategoryType;
  turns: number;
  tokens: number;
  cost: number;
}

export interface GroupDailyCost {
  date: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface GroupUsageSummary {
  totalCost: number;
  totalTokens: number;
  totalSessions: number;
  totalTurns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** `undefined` when nothing was read, written, or input — "n/a", not 0%. */
  cacheHitRate?: number;
  subagentCost: number;
  subagentTokens: number;
  /** Merged by model, sorted by cost descending. */
  byModel: GroupModelCost[];
  /** Merged by category, sorted by cost descending. */
  byCategory: GroupCategoryCost[];
  /** Merged by date, sorted ascending. */
  daily: GroupDailyCost[];
}

function mergeBy<T extends object, K extends keyof T>(
  rows: readonly T[],
  key: K,
  add: (into: T, row: T) => void,
  pick: (row: T) => T
): T[] {
  const out = new Map<T[K], T>();
  for (const row of rows) {
    const existing = out.get(row[key]);
    if (existing === undefined) out.set(row[key], pick(row));
    else add(existing, row);
  }
  return [...out.values()];
}

export function sumUsageReports(reports: readonly UsageReport[]): GroupUsageSummary {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let totalCost = 0;
  let totalSessions = 0;
  let totalTurns = 0;
  let subagentCost = 0;
  let subagentTokens = 0;
  for (const r of reports) {
    totalCost += r.totalCost;
    totalSessions += r.totalSessions;
    totalTurns += r.totalTurns;
    subagentCost += r.subagentCost ?? 0;
    subagentTokens += r.subagentTokens ?? 0;
    tokens.input += r.tokens.input;
    tokens.output += r.tokens.output;
    tokens.cacheRead += r.tokens.cacheRead;
    tokens.cacheWrite += r.tokens.cacheWrite;
  }
  const totalTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  const cacheDenominator = tokens.cacheRead + tokens.input + tokens.cacheWrite;
  const cacheHitRate = cacheDenominator > 0 ? tokens.cacheRead / cacheDenominator : undefined;

  const byModel = mergeBy<GroupModelCost, "model">(
    reports.flatMap((r) => r.byModel),
    "model",
    (into, m) => {
      into.inputTokens += m.inputTokens;
      into.outputTokens += m.outputTokens;
      into.cacheReadTokens += m.cacheReadTokens;
      into.cacheCreateTokens += m.cacheCreateTokens;
      into.cost += m.cost;
      into.turns += m.turns;
    },
    (m) => ({
      model: m.model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheReadTokens: m.cacheReadTokens,
      cacheCreateTokens: m.cacheCreateTokens,
      cost: m.cost,
      turns: m.turns,
    })
  ).sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));

  const byCategory = mergeBy<GroupCategoryCost, "category">(
    reports.flatMap((r) => r.byCategory),
    "category",
    (into, c) => {
      into.turns += c.turns;
      into.tokens += c.tokens;
      into.cost += c.cost;
    },
    (c) => ({ category: c.category, turns: c.turns, tokens: c.tokens, cost: c.cost })
  ).sort((a, b) => b.cost - a.cost || a.category.localeCompare(b.category));

  const daily = mergeBy<GroupDailyCost, "date">(
    reports.flatMap((r) => r.daily),
    "date",
    (into, d) => {
      into.cost += d.cost;
      into.inputTokens += d.inputTokens;
      into.outputTokens += d.outputTokens;
      into.turns += d.turns;
    },
    (d) => ({
      date: d.date,
      cost: d.cost,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      turns: d.turns,
    })
  ).sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalCost,
    totalTokens,
    totalSessions,
    totalTurns,
    tokens,
    cacheHitRate,
    subagentCost,
    subagentTokens,
    byModel,
    byCategory,
    daily,
  };
}
