// Versioned-derivation stamp. Bump this whenever the business logic that
// produces *_derived columns (cost, classification, one-shot flags, cache
// hit ratio, etc.) changes in a way that should invalidate previously
// indexed rows.
//
// The indexer reconciles a session by comparing `sessions.derived_version`
// to this constant: if stale, the session is fully re-parsed even when
// its file mtime hasn't changed.
//
// Increment rules:
// - Bump when classifyTurn / detectOneShot / costCalculator semantics change.
// - Don't bump for additive columns (handle via schema migration instead).
// - Don't bump for FTS5 trigger changes (those rebuild on insert/update).
export const DERIVED_VERSION = 3;
// History:
// 1 — initial.
// 2 — added `tool_result_preview` storage so `detectOneShot` rehydrates
//     accurately after a tail-append. Existing rows lacked the column;
//     bumping forces a one-time full re-parse so all sessions are
//     populated before any tail relies on them.
// 3 — added `turns.cost_usd`, `sessions.verified_task_count`,
//     `sessions.one_shot_task_count`, and the `category_costs` rollup
//     (P2b-2.5). Existing rows have these defaulted to 0; bumping
//     drives a full re-parse so the SQL-aggregate read path returns
//     correct numbers. The migration sets `meta.needs_reconcile_after_v3`
//     as a readiness gate that the read-side façade checks before
//     trusting the SQL path.
