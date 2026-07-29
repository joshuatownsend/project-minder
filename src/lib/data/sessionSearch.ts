import "server-only";
import type DatabaseT from "better-sqlite3";
import { prepCached } from "@/lib/db/connection";
import { fuseRrf } from "./rrf";

// SQL-backed session search backing `/api/sessions/search`. Two distinct
// paths are stitched together depending on `scope`:
//
//   - `prompts` → FTS5 `MATCH` against `prompts_fts.text`, which since
//     schema v19 holds FULL turn bodies as overlapping chunks (prose +
//     extended thinking, including subagent transcripts) rather than the
//     old 500-char `turns.text_preview` mirror. Best for in-conversation
//     content matching: "did Claude help me debug the auth middleware in
//     any session?" Prompt hits also carry a `snippet` excerpt, because
//     the row renderer has no other access to that text.
//   - `titles`  → `LIKE` over `sessions` columns (`slug`,
//     `initial_prompt`, `last_prompt`, `project_dir_name`,
//     `git_branch`). Best for slug-grouped lookup and project-name
//     prefix scans. Deliberately NOT routed through `prompts_fts`: those
//     columns are session metadata, not turn text, and are not indexed
//     there at all.
//   - `both`    → both retrievers run, and their two RANKED LISTS are
//     merged by Reciprocal Rank Fusion (`./rrf.ts`) rather than by
//     comparing scores. bm25 magnitudes and `LIKE` matches live on
//     incomparable scales; RRF fuses on ordinal position only, so no
//     normalization — and no invented constant — is required.
//
// Each retriever is queried for `CANDIDATE_MULTIPLIER x limit` rows so
// fusion has room to rescue a session that one retriever ranked deeply
// and the other ranked highly; the pool is truncated to `limit` after.
//
// Returns a flat ranked-by-score list of `(sessionId, score)` pairs.
// Callers (the route + the SessionsBrowser client filter) join against
// the cached full SessionSummary list to compose responses — keeping
// search separate from the much-heavier list assembly avoids re-walking
// the 6 queries that loader does on every keystroke.

export interface SessionSearchHit {
  /** Matching session_id (one entry per session — the loader dedupes). */
  sessionId: string;
  /**
   * Reciprocal Rank Fusion score (see `./rrf.ts`). Strictly positive and
   * descending-sortable, but NOT a relevance percentage — only the
   * ORDER is meaningful, and absolute values are small by construction
   * (a lone rank-1 hit scores ~0.016). Do not render as a percentage.
   *
   * Replaces the previous scheme, which squashed bm25 into [0,1] for
   * prompt hits and assigned a hardcoded 0.5 to every title hit. That
   * made all title hits tie with each other and gave them an arbitrary
   * threshold advantage over prompt hits scoring below 0.5.
   */
  score: number;
  /**
   * Which retriever contributed most to this hit's score. `'titles'`
   * for sessions-column matches, `'prompts'` for FTS5 turn matches.
   * Ties resolve to `'titles'` (it is fused first) — preserving the
   * long-standing intent that column-specific matches are more
   * user-meaningful than generic preview hits.
   */
  source: "titles" | "prompts";
  /**
   * 1-based rank within each retriever that found this session, absent
   * for retrievers that didn't. Purely diagnostic: it makes "why did
   * this outrank that?" answerable from an API response without
   * re-running the query. Additive — no existing consumer reads it.
   */
  ranks: { titles?: number; prompts?: number };
  /**
   * Excerpt of the matched text, from FTS5's `snippet()` on the
   * best-ranked chunk. Present only for `prompts` hits — a `titles` hit
   * matched a column the row already displays.
   *
   * This exists because the row renderer otherwise has nowhere to get
   * one: `SessionSummary.searchableText` is assembled from
   * `turns.text_preview` (500 chars, and `WHERE text_preview <> ''`
   * excludes sidechain rows entirely), so a match in a long body, in
   * extended thinking, or in a subagent transcript could not be shown at
   * all — the row would display an unrelated preview instead. Since
   * `prompts_fts` now holds the full text, the excerpt can come from the
   * genuinely matched content.
   */
  snippet?: string;
}

export type SessionSearchScope = "titles" | "prompts" | "both";

/**
 * Tokenize raw user input into a safe FTS5 MATCH expression. FTS5's
 * native query syntax exposes `:` `"` `*` `(` `)` `OR` `NEAR` etc.
 * directly; un-escaped user input that contains any of those breaks
 * the parser and surfaces as a SQLite error inside `prepare().all()`.
 *
 * Strategy: split on whitespace, drop empty tokens, double-quote each
 * token (escaping internal double-quotes by doubling them per FTS5
 * spec), and append a `*` prefix wildcard so partial words match
 * (`"auth"*` matches `authentication`, `authorize`, `authority`). Join
 * with spaces — FTS5 reads space as implicit AND.
 *
 * Returns `null` when the cleaned query is empty (caller treats as
 * a no-op no-match).
 */
export function buildFtsQuery(raw: string): string | null {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => '"' + t.replace(/"/g, '""') + '"*');
  if (tokens.length === 0) return null;
  return tokens.join(" ");
}

/**
 * Run a session search against the indexed corpus. Returns hits in
 * descending score order, capped at `limit`. The caller composes the
 * full SessionSummary objects from a separately-cached list — this
 * function deliberately does NOT join against `sessions` so the
 * keystroke-rate query path stays small.
 *
 * Parse failure on the FTS5 expression (broken tokenizer input,
 * driver throw, etc.) is caught and rethrown as a typed
 * `SessionSearchError` so the route can return 400 instead of letting
 * the better-sqlite3 stack escape as a 500.
 */
export class SessionSearchError extends Error {
  readonly reason: "fts-parse" | "invalid-scope";
  constructor(reason: "fts-parse" | "invalid-scope", message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionSearchError";
    this.reason = reason;
  }
}

const DEFAULT_LIMIT = 50;

/**
 * How many candidates to pull from EACH retriever before fusing, as a
 * multiple of the caller's `limit`.
 *
 * Fusion can only reorder what it is given. Fetching exactly `limit` rows
 * per list would mean a session ranked 55th by keyword but 1st by title
 * never enters the pool for a `limit=50` query — precisely the cross-
 * retriever rescue RRF exists to perform. Over-fetching 3x costs one
 * wider SQLite scan and is discarded immediately after fusion.
 */
const CANDIDATE_MULTIPLIER = 3;
/** Absolute ceiling on the over-fetch, so `limit=200` can't scan 600 rows. */
const MAX_CANDIDATES = 300;

/**
 * Per-retriever fusion weights.
 *
 * Titles are weighted above prompts because a match on a slug, project
 * name, or git branch is a deliberate, high-precision signal, whereas a
 * turn-preview match can be incidental. This encodes the intent the
 * previous implementation expressed as a hardcoded `0.5` score floor plus
 * a `>=` tie-break — but as a smooth per-rank weight rather than a cliff.
 */
const TITLE_WEIGHT = 1.5;
const PROMPT_WEIGHT = 1.0;

interface FtsRow {
  session_id: string;
  rank: number;
}

interface TitleRow {
  session_id: string;
}

export function searchSessionsInDb(
  db: DatabaseT.Database,
  query: string,
  scope: SessionSearchScope,
  limit: number = DEFAULT_LIMIT
): SessionSearchHit[] {
  const q = query.trim();
  if (!q) return [];

  if (scope !== "titles" && scope !== "prompts" && scope !== "both") {
    throw new SessionSearchError("invalid-scope", `unknown scope: ${scope}`);
  }

  // Each retriever produces a ranked list of session_ids, best-first.
  // Neither list's raw scores are ever compared against the other's —
  // `fuseRrf` consumes ordinal position only. See `./rrf.ts`.
  const candidateLimit = Math.min(limit * CANDIDATE_MULTIPLIER, MAX_CANDIDATES);
  let promptKeys: string[] = [];
  let titleKeys: string[] = [];
  // Excerpt per session, from the best-ranked matching chunk. Carried
  // alongside the ranked lists rather than through `fuseRrf`, which is
  // deliberately generic over opaque string keys and must not learn
  // about session-specific payloads.
  const snippetBySession = new Map<string, string>();

  if (scope === "prompts" || scope === "both") {
    const ftsExpr = buildFtsQuery(q);
    if (ftsExpr) {
      let rows: FtsRow[];
      try {
        // FTS5 exposes `rank` as a virtual column equal to bm25 by
        // default; reading it directly in a column projection works,
        // but wrapping `bm25(prompts_fts)` in an aggregate function
        // throws "unable to use function bm25 in the requested
        // context" because bm25 needs row-level FTS context.
        //
        // The subquery shape below picks per-row rank inside the MATCH
        // context and aggregates plain-number rank values in the
        // outer query.
        //
        // `snippet()` carries the SAME restriction, and it is stricter
        // than it first appears: it fails not only inside an aggregate
        // but also alongside a window function ("unable to use function
        // snippet in the requested context"), because SQLite
        // materializes the subquery and the FTS row context is gone by
        // the time the outer query runs. So snippets CANNOT be folded
        // into this ranking query — they are fetched separately below.
        rows = prepCached(
          db,
          `SELECT session_id, MIN(rank) AS rank
             FROM (
               SELECT session_id, rank
                 FROM prompts_fts
                WHERE prompts_fts MATCH ?
             )
            GROUP BY session_id
            ORDER BY rank
            LIMIT ?`
        ).all(ftsExpr, candidateLimit) as FtsRow[];

        // Second pass, purely for excerpts. A plain projection over the
        // MATCH keeps the FTS row context `snippet()` requires — no
        // aggregate, no window. Rows arrive best-first, so the FIRST
        // occurrence of each session is its best-ranked chunk; later
        // chunks of the same session are skipped.
        //
        // Column 5 is `text` — (session_id, turn_index, chunk_index,
        // role, ts, text), 0-indexed. Empty start/end markers because
        // the client highlights by locating the query itself; markup
        // emitted here would have to be escaped downstream.
        //
        // Bounded at 2x the candidate pool rather than unbounded: the
        // limit counts CHUNKS, not sessions, so one very long session
        // could otherwise crowd out the rest. If it does, the sessions
        // that miss out simply have no snippet and the row falls back to
        // its previous rendering — degraded, never wrong.
        const snipRows = prepCached(
          db,
          `SELECT session_id, snippet(prompts_fts, 5, '', '', '…', 18) AS snip
             FROM prompts_fts
            WHERE prompts_fts MATCH ?
            ORDER BY rank
            LIMIT ?`
        ).all(ftsExpr, candidateLimit * 2) as Array<{
          session_id: string;
          snip: string | null;
        }>;
        for (const r of snipRows) {
          if (r.snip && !snippetBySession.has(r.session_id)) {
            snippetBySession.set(r.session_id, r.snip);
          }
        }
      } catch (err) {
        // bm25() requires the FTS column was indexed; the wrapped
        // expression should always be syntactically valid given our
        // tokenizer, but if FTS5 rejects it (rare — usually a token
        // that exhausts column qualifiers), surface as a 400.
        throw new SessionSearchError(
          "fts-parse",
          `FTS5 rejected query: ${(err as Error).message}`,
          err
        );
      }
      // `ORDER BY rank` already emits best-first (FTS5 bm25 is negative,
      // more-negative = better, so ascending IS descending relevance).
      // Position in this array is the rank RRF consumes; the raw bm25
      // magnitude is deliberately discarded — that's the entire point of
      // fusing on ordinals rather than normalizing incomparable scales.
      promptKeys = rows.map((r) => r.session_id);
    }
  }

  if (scope === "titles" || scope === "both") {
    // LIKE-pattern search across the title-class columns. Bind the
    // pattern once with `'%' || ? || '%'` semantics so the user input
    // never mixes with SQL syntax.
    const pat = `%${q.toLowerCase()}%`;
    const rows = prepCached(
      db,
      `SELECT session_id FROM sessions
         WHERE slug IS NOT NULL AND lower(slug) LIKE ?
            OR initial_prompt IS NOT NULL AND lower(initial_prompt) LIKE ?
            OR last_prompt IS NOT NULL AND lower(last_prompt) LIKE ?
            OR project_dir_name IS NOT NULL AND lower(project_dir_name) LIKE ?
            OR git_branch IS NOT NULL AND lower(git_branch) LIKE ?
         ORDER BY end_ts DESC
         LIMIT ?`
    ).all(pat, pat, pat, pat, pat, candidateLimit) as TitleRow[];

    // `LIKE` yields no relevance score at all, so recency (`end_ts DESC`)
    // is the only ordering signal available. RRF's k=60 damping is what
    // keeps that weak signal from being over-trusted at deep ranks.
    titleKeys = rows.map((r) => r.session_id);
  }

  // Titles are fused FIRST so they win `topSource` on an exact tie — the
  // documented preference carried over from the previous implementation.
  const fused = fuseRrf([
    { label: "titles", keys: titleKeys, weight: TITLE_WEIGHT },
    { label: "prompts", keys: promptKeys, weight: PROMPT_WEIGHT },
  ]);

  return fused.slice(0, limit).map((f) => ({
    sessionId: f.key,
    score: f.score,
    source: f.topSource as "titles" | "prompts",
    ranks: {
      ...(f.ranks.titles !== undefined ? { titles: f.ranks.titles } : {}),
      ...(f.ranks.prompts !== undefined ? { prompts: f.ranks.prompts } : {}),
    },
    // Only prompt hits carry one; a title hit matched a column the row
    // already renders.
    ...(snippetBySession.has(f.key) ? { snippet: snippetBySession.get(f.key) } : {}),
  }));
}
