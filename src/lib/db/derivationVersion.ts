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
export const DERIVED_VERSION = 11;
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
// 6 — Wave 4.2 added `sessions.{has_thinking, cli_version,
//     has_resume_anomaly, compact_boundary_count}` and
//     `turns.{turn_duration_ms, has_thinking, text_offset}`.
//     text_offset is populated by ingest for the on-demand thinking
//     content reader. Bumping drives a full re-parse so all sessions
//     get the new fields. No read-side gate needed — missing values
//     degrade to "thinking content unavailable" / no duration badge,
//     both of which are explicit non-silent UX states.
// 7 — Wave 8.3 added `tool_uses.{is_error (was always 0), error_category,
//     invocation_source}` and `sessions.{work_mode_*_pct}`. All four
//     work-mode columns are derived from turns.category at session
//     finalization; error fields require re-reading tool_result blocks
//     in user turns. Bumping forces a full re-parse so these are
//     populated across the existing corpus. No read-side gate — NULL
//     work_mode columns degrade to "no work-mode strip", NULL error
//     columns to "no error category breakdown", both non-silent.
// 8 — T2.2 added the `session_prs` table populated by extracting
//     `gh pr create` results from JSONL `tool_result` blocks. Without
//     this bump, existing sessions (no mtime/size change) would skip
//     re-parse and remain PR-less indefinitely; only newly-modified
//     sessions would populate the new table. Bumping drives a one-time
//     re-parse so every session that ever ran `gh pr create` gets its
//     PRs backfilled into the table.
//
//     **Tail-straddle recovery (review #1).** A PR whose `gh pr create`
//     Bash call lands in already-persisted bytes but whose `tool_result`
//     arrives in a later tail-append is recovered by a fallback
//     full-file PR extraction (`recoverStraddledPrs` in ingest.ts),
//     gated on a cheap `hasOrphanToolResults` flag computed during the
//     tail parse. This catches the call/result-cross-cursor case without
//     needing another DERIVED_VERSION bump.
//
//     No read-side gate — missing rows just mean no chip renders for
//     that session, never a wrong chip.
// 9 — item3 added the `session_tickets` table, populated by scanning all
//     session text (prompts, assistant text, tool_result output) for full
//     Linear/Jira/GitHub-issue URLs. Same rationale as v8: without this
//     bump, existing sessions (no mtime/size change) skip re-parse and
//     stay ticket-less indefinitely; only newly-modified sessions would
//     populate the new table. Bumping drives a one-time re-parse so every
//     session that ever referenced a tracker URL gets backfilled.
//
//     No tail-straddle recovery is needed (unlike v8's PRs): tickets are
//     harvested by a plain text scan, not a call→result pairing, so there
//     is no cross-cursor case to recover — tickets in already-persisted
//     bytes are carried forward by `preservedTickets` on every rewrite.
//
//     No read-side gate — missing rows just mean no chip renders.
// 10 — usage-accuracy fixes (A1/A3/A6). Schema v17 added `turns.is_sidechain`;
//     subagent (Task/sidechain) assistant turns are now persisted as rows so
//     their tokens/cost fold into the usage totals (A1). Ingest also
//     propagates the triggering user prompt onto assistant turns before
//     classification (A3, changes some `turns.category` values) and de-dups
//     repeated `message.id` lines (A6). All three change previously-derived
//     rows, so existing sessions (unchanged mtime/size) must re-parse to gain
//     sidechain rows and corrected categories. No read-side gate — pre-
//     reconcile the totals simply omit subagent spend (the prior behavior),
//     which is degraded, not wrong.
// 11 — classifier: TESTING_CMD_RE now matches `pnpm test` / `yarn test` /
//     `bun test` (and `pnpm run test`, etc.), so Bash turns running those move
//     from `Coding` to `Testing`. Because this changes `classifyTurn` output,
//     already-indexed sessions (unchanged mtime/size) would keep their stale
//     `turns.category` / `category_costs` on the SQLite backend until the file
//     next changed — undercounting Testing. Bumping forces a one-time re-parse
//     so the corpus reclassifies. No read-side gate — pre-reconcile the
//     affected turns just read as `Coding` (the prior behavior), degraded not
//     wrong.
