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
// - Bump when a schema migration adds columns whose values must be
//   re-extracted from the JSONL — without a bump, mtime+size unchanged
//   files skip re-parse and the new columns stay NULL on the existing
//   corpus indefinitely (only newly-modified files would populate them).
// - Don't bump for FTS5 trigger changes (those rebuild on insert/update).
export const DERIVED_VERSION = 5;
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
// 4 — Wave 2.1 schema v5 added `sessions.slug` and
//     `sessions.continued_from_session_id`. The slug is extracted from
//     JSONL assistant entries' top-level `slug` field, so existing
//     sessions need a re-parse to populate it. Bumping drives that
//     re-parse; the post-reconcile `refreshContinuationLinks` UPDATE
//     then derives the chain. No read-side gate — slug=NULL during
//     catch-up is degraded UX (no "continued" badge, no
//     /sessions/<slug> resolution) but never wrong.
// 5 — Wave 3.1 populated the long-pre-allocated quality columns:
//     `sessions.has_compaction_loop`, `sessions.has_tool_failure_streak`,
//     `sessions.max_context_fill`, and `turns.context_fill`. These were
//     added to schema.sql at v1 in anticipation of this wave but never
//     written until now. Existing rows have them defaulted to 0/NULL;
//     bumping drives a re-parse so SessionsBrowser badges and the
//     Diagnosis tab agree across the corpus. No read-side gate — pre-
//     reconcile, badges simply don't render and Diagnosis is computed on
//     demand from the JSONL (file-parse path), so degraded UX never
//     produces wrong numbers.
