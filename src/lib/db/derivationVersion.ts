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
// - Don't bump for `catalog_fts` trigger changes (those rebuild on
//   insert/update, because their source tables store the indexed text).
//   This exemption NO LONGER covers `prompts_fts`: as of schema v19 it is
//   writer-populated from full JSONL text that is never stored in `turns`,
//   so nothing rebuilds it on an UPDATE and only a real re-parse can fill
//   it. Changes to what goes into it DO require a bump.
//
// **The comparison is directional.** "Stale" means `stored < DERIVED_VERSION`,
// never `stored !== DERIVED_VERSION`. Rows stamped ABOVE this constant were
// written by a build that knows more than this one does, and re-deriving them
// here would drop every column that build added. The gates in `ingest.ts`
// enforce this via `isNewerDerivation`; see the 2026-08-05 entry below for
// what it costs when they don't.
export const DERIVED_VERSION = 20;
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
// 12 — schema v19 made `prompts_fts` hold FULL turn bodies (prose + extended
//     thinking) as overlapping chunks instead of the 500-char
//     `turns.text_preview` mirror. This is the one bump reason that is
//     structural rather than semantic: the full text is NOT stored in any
//     column, so unlike every prior entry there is nothing to re-derive
//     from — only a genuine JSONL re-read can populate the index, and
//     `derived_version` staleness is what forces one. Without the bump the
//     new index would stay empty on the existing corpus indefinitely and
//     prompt-scope search would silently return almost nothing.
//
//     Thinking-block text is newly captured at parse time (it was
//     previously read for the `has_thinking` flag and then discarded), so
//     the re-parse is also what makes thinking searchable at all.
//
//     Scope limit: the adapter path (Codex/Gemini) caps text at 500 chars
//     inside each adapter (`adapters/utils.ts` TEXT_CAP) before ingest sees
//     a turn, so those sessions remain preview-indexed. Widening that
//     requires changing the SessionAdapter contract, deliberately not done
//     here.
//
//     No read-side gate — during catch-up, prompt search returns fewer hits
//     than it will afterwards. Degraded, not wrong; a gate would make it
//     return nothing, which is worse.
// 13 — schema v20 (A1) added columns and tables for transcript fields Claude
//     Code has been writing since ~2.1.212 that Minder decoded none of:
//     `turns.{effort, attribution_skill, attribution_mcp_server,
//     attribution_mcp_tool}`, `sessions.{session_kind, ai_title, entrypoint}`,
//     `tool_uses.denial_kind`, and the `session_hook_runs` /
//     `session_permission_modes` tables.
//
//     Standard "new columns need re-extraction" bump (rule 2 above): the
//     values exist only in the JSONL, so without it every unchanged file
//     skips re-parse and the new columns stay NULL on the whole corpus —
//     only newly-modified sessions would ever populate them.
//
//     **This bump is shared.** It is the single re-parse for the entire A
//     wave: A2 (effort analytics), A3 (sessionKind segmentation), A4
//     (authoritative attribution), A5 (authoritative PR linkage) and A6 (hook
//     + permission analytics) all read columns this decode fills, and all ride
//     this one re-parse rather than bumping again. A later slice that needs
//     its own re-parse should say why the shared one was insufficient.
//
//     No read-side gate. Pre-reconcile, the new fields read as NULL — which is
//     exactly what a genuinely pre-2.1.212 transcript reports, so consumers
//     already have to handle it. That equivalence is why no gate is needed,
//     and it is also the reason every A1 field is optional: "not yet
//     re-indexed" and "this transcript never had it" are indistinguishable by
//     design, and neither may be rendered as a default value.
// 14 — schema v21 (A2) added `turns.task_outcome`, which records against each
//     task's anchor turn whether that task passed verification first time.
//
//     **Why the shared v13 re-parse was insufficient.** v13 reserved itself for
//     the whole A wave and asked any later slice to justify bumping again. The
//     justification is that `task_outcome` is not a decode — it is not present
//     in the JSONL under any name. It is the output of `detectOneShotTasks`
//     running over a session's full turn sequence, which only happens at
//     ingest. A migration cannot backfill it (the sequence isn't in SQL) and a
//     read-side query cannot recover it (that was the whole reason to persist
//     it). Only a re-parse computes it.
//
//     **Cost.** At the time of writing this is free: the v13 re-parse had not
//     yet run on the author's machine, so the corpus was already stale at 12
//     and both bumps collapse into the single re-parse v13 planned for. If v13
//     HAS already been reconciled by the time this lands, it costs one further
//     full re-parse — the honest price, stated rather than hidden, because a
//     cheaper alternative would have meant an approximate cross-tab.
//
//     No read-side gate. Pre-reconcile, `task_outcome` is NULL everywhere, so
//     the effort cross-tab reports `verifiedTasks: 0` and `oneShotRate:
//     undefined` for every bucket — which the UI already has to render for a
//     genuinely task-free period. Degraded, never wrong: no bucket claims a 0%
//     success rate it did not measure.
// 15 — schema v22 (A5) added `session_prs.source`, recording whether a PR link
//     was reported by Claude Code or scraped out of `gh pr create` output.
//
//     **The migration comment promised a re-parse that nothing scheduled.** It
//     said existing rows "re-populate on the next reconcile like every other
//     derived column", and that was wrong in both directions a session can
//     take: an unchanged transcript hits the no-op gate in `reconcileSessionFile`
//     and is never re-read, while a growing one takes the tail path, which
//     appends from the end and never revisits PR entries already indexed in the
//     prefix. Without a bump, every pre-upgrade PR chip would keep unknown
//     provenance permanently (Codex review, #385).
//
//     Deliberately not a backfill. The obvious migration — stamp every existing
//     row `scraped` — would put a wrong provenance on the majority of 652 rows
//     that were in fact recorded, and provenance exists precisely to say which
//     source to trust. NULL means "written before this column existed", which
//     is the truth until the re-parse supplies the real answer.
// 16 — A6: `session_hook_runs` had never received a row, on any machine.
//
//     Not a new column — the table shipped with v13/schema v20 and has been
//     structurally impossible to populate ever since. Both readers looked for
//     `hookInfos` on assistant entries; it rides `type:"system"` entries, on
//     4,189 of 4,189 carriers across the local corpus and zero assistant ones.
//     In `ingest.ts` the decode sat below `if (entry.type === "system") { …
//     continue; }`, so the guard reached it first; in `claudeConversations.ts`
//     it sat inside the assistant branch. A fully-reconciled 1.5 GB index held
//     0 rows.
//
//     **Why a bump is unavoidable.** The data is in the JSONL and nowhere else,
//     so this is rule 2 (new extraction needs re-parse) applied to a decode
//     that was written but never ran. Without it every unchanged session keeps
//     its v14 stamp, skips re-parse, and its hook history stays permanently
//     invisible — only sessions modified after this ships would ever populate.
//     No migration can backfill it: `session_hook_runs` has no source in SQL.
//
//     Also lands `session_hook_errors` (schema v23), decoded from the sibling
//     `hookErrors` array on the same entries.
//
//     No read-side gate needed. Pre-reconcile the table is empty, which is
//     exactly what it has always been, so nothing regresses during catch-up —
//     and `getHookActivity` reports `hasData: false` rather than claiming a
//     hook-free machine. That said, an empty result here is precisely the
//     failure mode that hid this bug for a whole slice, so the result now
//     carries a `source` field saying which pipeline answered.
// 17 — C3: `turns.request_id`, the join key between the transcript and OTEL.
//
//     C3 was specified against `message.uuid`. That field does not appear in
//     this data under any spelling — an enumeration of every attribute key on
//     4,000 tool/api events turned up `user.account_uuid` and `request_id`, and
//     nothing else uuid-shaped. `requestId` is the key that works, and it was
//     already on both sides: on assistant transcript entries, and as
//     `attrs.request_id` on `api_request` events. Verified by intersection over
//     the full corpus: 71,466 of 205,137 assistant turns (34.8%) match an OTEL
//     event, with all 39,139 `api_request` events carrying a distinct value.
//
//     Needs a bump for the usual reason — the value is in the JSONL and nowhere
//     else, so unchanged sessions would keep a NULL column forever.
//
//     **Free in practice.** This lands stacked on A5's v15 and A6's v16, neither
//     of which has been reconciled anywhere yet, so all three collapse into one
//     re-parse — the same accounting A2 made against A1's v13. If v16 has
//     already run by the time this merges, it costs one further pass; stated
//     rather than hidden.
//
// 18 — W4 pricing corrections. `turns.cost_usd` is stamped at ingest, so a
//     change to the cost FORMULA leaves every previously-indexed row holding a
//     number computed by the old one. Three formula changes land together:
//
//       - the >200k tier now also applies to cache read and cache write
//         rates (#393), which raises long-context Sonnet 4/4.5 turns;
//       - `usage.speed === "fast"` bills at the premium Opus 5 / 4.8 rates
//         rather than standard, which doubles those turns;
//       - the file-parse scan cache persists its per-model/per-rate split
//         (#394) — not a DB change itself, but it means the two backends
//         would otherwise heal on different schedules.
//
//     This is the textbook case for the "bump when costCalculator semantics
//     change" rule at the top of this file, and it is the one bump reason that
//     is invisible without it: nothing errors, no column is NULL, and no test
//     can see it — a test always ingests with current code, so only a real
//     user's existing DB carries old-rate rows. Left unbumped, the SQLite and
//     file-parse backends would report different costs for exactly the turns
//     these fixes touch, which is the #220 parity class all over again.
//
//     **Cost, measured rather than assumed — and it does not favour the bump.**
//     v17 is fully reconciled on this machine (6,011 of 6,011 sessions), so
//     unlike v15–v17 this does NOT ride along on an unreconciled predecessor:
//     it is a genuine additional full re-parse (~45 min at the v14 timing).
//     And on this corpus it will change ZERO rows. Of 102,179 priced turns,
//     the count with a >200k prompt on a tiered-lineage model — Sonnet 3.5 /
//     3.7 / 4 / 4.5, the only models that publish a tier — is 0. Every one of
//     the 47,912 long-prompt turns here is Opus 4.8 / Opus 5 / Fable 5 /
//     Sonnet 5, all flat across the full 1M window. `speed = "fast"` has never
//     been observed either.
//
//     Bumped anyway, for two reasons that outlive this machine. First, the
//     rule at the top of this file is unconditional and this is squarely a
//     costCalculator semantics change; making an exception for "my corpus
//     happens not to hit it" is how a constant like this stops being
//     trustworthy. Second, a user who DID run Sonnet 4/4.5 above 200k would
//     otherwise get a file-parse backend that heals (scan-cache v2) and a
//     SQLite backend that does not — the two reporting different costs for the
//     same turns, which is precisely the backend-parity failure class of #220.
//
//     If the re-parse cost is ever judged too high for a change this narrow,
//     the honest alternative is a targeted re-price of the affected rows, not
//     silently skipping the bump.
// 19 — #426: `tool_uses` ingest was dropping every tool call that arrived on a
//     repeat `message.id` line. Claude Code writes ONE LINE PER CONTENT BLOCK,
//     all lines of a message sharing an id and repeating the message-level
//     `usage` verbatim; the old A6 guard `continue`d on the repeat and threw
//     the block away. Measured on one 47 MB transcript: 2,716 `tool_use` blocks
//     in the file against 720 rows stored — exactly those on a first-seen id —
//     with `Agent` at 72 → 6. Corpus-wide, 5,652 of 6,036 sessions held no
//     `tool_uses` rows at all.
//
//     Unlike v18 this bump changes a great many rows, and not only in
//     `tool_uses`: the dropped lines also carried text and thinking blocks, so
//     `text_preview`, the FTS `search_text`, and `usageTurn.assistantText` were
//     truncated to whatever the message's first block happened to be. Because
//     `assistantText` and `toolCalls` are the classifier's inputs, categories
//     move on re-parse, and with them `task_outcome` anchoring and every
//     one-shot rate derived from it.
//
//     This is the one bump kind that IS visible to a test — a fixture whose
//     message spans several lines fails loudly without the fix. It is listed
//     here anyway because the *stored* rows are what the bump exists for: a
//     user's existing index holds the old, short counts, and nothing about
//     them looks broken from the read side.
//
//     **Cost.** A genuine full re-parse, and unlike v18 it changes a large
//     share of rows rather than none. The last measured full pass was v14 at
//     45.3 minutes over 4,894 files; this corpus is larger (6,036 sessions),
//     so budget an hour. Verified against the transcript that exposed the bug
//     — re-ingested in isolation it stored 2,694 `tool_uses` against 2,694
//     distinct `tool_use_id`s in the file, `Agent` 6 -> 72, and 2,350
//     assistant turns, matching the raw counts exactly.
// 20 — #395: two new derived facts per session, neither of which any prior
//     parse produced — `sessions.parent_session_id` (which session spawned this
//     subagent transcript, from its path) and `sidechain_tool_counts` (tool
//     calls made inside subagent turns). Together they make a session's whole
//     delegation tree countable for the first time; before this, a subagent's
//     tool calls were not stored anywhere, so the cap comparison on /sessions
//     asked a table that structurally could not answer and read the resulting
//     zero as "no nested work".
//
//     **This bump is load-bearing, not bookkeeping.** The roll-up refuses to
//     report a tree total unless the root AND every linked child is stamped at
//     20 — see `sessionsListFromDb`. Without the bump, a v19 index would carry
//     the new columns as empty and the roll-up would silently equal the
//     root-only count it replaced: the partial-count comparison #395 exists to
//     stop, wearing the new field's name. `stale ⇒ unmeasured` is only
//     expressible because the version moved.
//
//     **Cost.** None on its own — v19's full re-parse was already outstanding
//     and unrun on the reference index (found at 17). Shipping both in one
//     release means one pass (~1 hour, 6,036 sessions) delivers #426 and #395
//     together instead of two. Verified against the corpus that motivated it:
//     1,260 subagent transcripts, 37,394 `tool_use` blocks over 37,311 distinct
//     ids (hence the id dedupe), `Agent` 62 and `WebSearch` 123 nested — none of
//     which had ever reached the index.
//
// ─────────────────────────────────────────────────────────────────────────────
// 2026-08-05 — what a non-directional comparison cost, recorded here because
// this is the file the next person changing these rules will open.
//
// The v14 re-parse ran to completion: 45.3 minutes, 4,894 files, 260,308 rows,
// `errors: 0`, 22,682 `turns.effort` values and 1,141 `task_outcome` stamps
// verified against the pre-existing session counters. About thirty minutes
// later a tray packaged two days earlier — `DERIVED_VERSION = 12` — started up
// and ran its ordinary background reconcile. The index was later found holding
// 5,001 sessions, every one stamped 12, with all of those columns empty.
//
// Nothing failed. The gates asked `stored === DERIVED_VERSION`, which is false
// for 14-vs-12 exactly as it is for 11-vs-12, so newer rows were indistinguishable
// from stale ones and were "refreshed" downward. The pass reported `errors: 0`
// because from its point of view it had done its job.
//
// Two details worth keeping. The destructive path was NOT the no-op skip gate —
// that one requires mtime AND size to match, so only idle sessions reached it.
// Active sessions GREW, missed the no-op gate, failed the version equality that
// gates tail-append, and fell through to full-replace. A fix applied only to the
// skip gate would have looked right and still lost the same data. And the loss
// was silent in the UI: it presents as "the feature I shipped yesterday renders
// nothing", which reads as a UI bug and sends you looking in the wrong layer.
// Hence `newerDerivationSkips` and the warning line — the condition now names
// itself rather than having to be inferred from an empty panel.
