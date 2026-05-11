// Memory Observatory Phase 1, Feature D. Three numerical thresholds shape the
// budget chips on /memory. All three are hardcoded -- physics-driven limits
// from Bustamante's "Agent Memory Engineering" (Claude Code's 200-line index
// truncation cap; Hermes's ~32KB always-loaded soft budget) rather than user
// preferences. If we ever learn one is wrong, change it here in one place.

/** Article-documented hard truncation cap on MEMORY.md (always-loaded index). */
export const MEMORY_INDEX_LINE_CAP = 200;

/** Per-file size above which the row gets an explicit `N KB` size chip. */
export const MEMORY_FILE_LARGE_BYTES = 4 * 1024;

/** Soft budget for total always-loaded body bytes (informational only). */
export const MEMORY_TOTAL_BODY_BUDGET_BYTES = 32 * 1024;

export type BudgetTone = "ok" | "warn" | "alarm";

/**
 * Map a (value, cap) pair to a tone:
 *   - >= 95% of cap => alarm (data-loss imminent / firmly over budget)
 *   - >= 80% of cap => warn  (approaching the cap, plan a trim)
 *   - otherwise      => ok
 *
 * Decoupled from the UI so the same thresholds drive tests and any future
 * non-React surfaces (CLI, MCP tool exposure, etc).
 */
export function budgetTone(value: number, cap: number): BudgetTone {
  if (cap <= 0) return "ok";
  const pct = value / cap;
  if (pct >= 0.95) return "alarm";
  if (pct >= 0.8) return "warn";
  return "ok";
}

/**
 * Render N bytes as a short human string ("3.7 KB", "812 B"). One decimal
 * for KB, no decimal for B. No MB tier — memory files never get that large
 * in practice; if they ever do, the alarm tone already flagged it.
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}
