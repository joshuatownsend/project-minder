// Numerical thresholds shaping the budget chips on /memory. All three are
// hardcoded -- physics-driven limits from Bustamante's "Agent Memory
// Engineering" (Claude Code's 200-line index truncation cap; Hermes's ~32KB
// always-loaded soft budget) rather than user preferences. Change in one
// place if the article-documented numbers shift.

export const MEMORY_INDEX_LINE_CAP = 200;
export const MEMORY_FILE_LARGE_BYTES = 4 * 1024;
export const MEMORY_TOTAL_BODY_BUDGET_BYTES = 32 * 1024;

/**
 * Cutoff for the "Unread" filter chip. Mirrors the existing age-based
 * staleness signal so both filters tell the same 30-day story. Server +
 * help doc + chip label all read from this constant so the contract has
 * one source of truth.
 */
export const MEMORY_UNREAD_WINDOW_MS = 30 * 24 * 60 * 60_000;

export type BudgetTone = "ok" | "warn" | "alarm";

/**
 * 80% / 95% bands per CONTEXT decision D3. Decoupled from the UI so the
 * same thresholds drive tests and any future non-React surfaces (CLI, MCP
 * tool exposure, auto-prune recommender).
 */
export function budgetTone(value: number, cap: number): BudgetTone {
  if (cap <= 0) return "ok";
  const pct = value / cap;
  if (pct >= 0.95) return "alarm";
  if (pct >= 0.8) return "warn";
  return "ok";
}
