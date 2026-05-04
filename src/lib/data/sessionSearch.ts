import "server-only";
import type DatabaseT from "better-sqlite3";
import { prepCached } from "@/lib/db/connection";

// SQL-backed session search backing `/api/sessions/search`. Two distinct
// paths are stitched together depending on `scope`:
//
//   - `prompts` → FTS5 `MATCH` against `prompts_fts.text` (which mirrors
//     `turns.text_preview`). Best for in-conversation content matching:
//     "did Claude help me debug the auth middleware in any session?"
//   - `titles`  → `LIKE` over `sessions` columns (`slug`,
//     `initial_prompt`, `last_prompt`, `project_dir_name`,
//     `git_branch`). Best for slug-grouped lookup and project-name
//     prefix scans. NOT routable through `prompts_fts` because that
//     FTS table only indexes turn previews.
//   - `both`    → UNION ALL of the above with JS-side dedup by
//     `session_id`, retaining the higher of the two relevance scores
//     for ranking.
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
   * Relevance score in [0, 1]. FTS5 `bm25()` is reflected as `1 / (1 + bm25)`
   * so smaller bm25 scores (better matches) become larger relevance.
   * `LIKE` matches use a flat 0.5 to keep mixed-source UNION sortable
   * without claiming spurious precision.
   */
  score: number;
  /**
   * Which path produced this hit. `'titles'` for sessions-column
   * matches, `'prompts'` for FTS5 turn-preview matches. UNION mode
   * picks whichever score was higher and reports that origin.
   */
  source: "titles" | "prompts";
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

  const hits = new Map<string, SessionSearchHit>();

  if (scope === "prompts" || scope === "both") {
    const ftsExpr = buildFtsQuery(q);
    if (ftsExpr) {
      let rows: FtsRow[];
      try {
        // FTS5 exposes `rank` as a virtual column equal to bm25 by
        // default; reading it directly in a column projection works,
        // but wrapping `bm25(prompts_fts)` in an aggregate function
        // throws "unable to use function bm25 in the requested
        // context" because bm25 needs row-level FTS context. The
        // subquery shape below picks per-row rank inside the MATCH
        // context and aggregates plain-number rank values in the
        // outer query.
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
        ).all(ftsExpr, limit) as FtsRow[];
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
      for (const r of rows) {
        // Smaller bm25 = better match. Map onto (0, 1) so higher = better.
        const score = 1 / (1 + Math.max(0, r.rank));
        hits.set(r.session_id, { sessionId: r.session_id, score, source: "prompts" });
      }
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
    ).all(pat, pat, pat, pat, pat, limit) as TitleRow[];

    for (const r of rows) {
      const existing = hits.get(r.session_id);
      const titleScore = 0.5;
      // UNION-mode dedup: keep the higher score, and prefer 'titles' as
      // the source when scores tie — column-specific matches are more
      // user-meaningful than generic preview hits. Using `>=` rather
      // than `>` is what enforces the tie-break direction.
      if (!existing || titleScore >= existing.score) {
        hits.set(r.session_id, { sessionId: r.session_id, score: titleScore, source: "titles" });
      }
    }
  }

  return Array.from(hits.values()).sort((a, b) => b.score - a.score).slice(0, limit);
}
