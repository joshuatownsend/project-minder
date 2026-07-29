// Reciprocal Rank Fusion — merge N independently-ranked result lists into
// one ranking without ever comparing their raw scores.
//
// **Why fusion instead of score normalization.** Session search draws from
// two retrievers whose scores live on incomparable scales:
//
//   - `prompts` → FTS5 `bm25()`, an unbounded NEGATIVE number whose
//     magnitude depends on corpus statistics (term rarity, doc length).
//   - `titles`  → a `LIKE` scan, which has no score at all; its only
//     ordering signal is `end_ts DESC` (recency).
//
// There is no honest way to map those onto a shared [0,1] axis. The prior
// implementation tried, and the seam shows: title hits were assigned a
// hardcoded `titleScore = 0.5` "to keep mixed-source UNION sortable without
// claiming spurious precision", which meant (a) every title hit tied with
// every other title hit, and (b) any title match outranked any prompt match
// whose squashed bm25 landed below 0.5 — a threshold with no meaning.
//
// RRF sidesteps normalization entirely by discarding magnitude and keeping
// only each item's ORDINAL POSITION within its own list:
//
//     score(item) = Σ_lists  weight_list / (k + rank_list(item))
//
// An item ranked 3rd by keyword and 1st by title contributes from both. An
// item only one retriever found still scores, just less. Nothing needs to
// know what a bm25 of -7.4 "means".
//
// Reference: Cormack, Clarke & Buettcher (2009), "Reciprocal Rank Fusion
// outperforms Condorcet and individual Rank Learning Methods."

/**
 * Damping constant. Controls how sharply score falls off with rank.
 *
 * - Large `k` flattens the curve: rank 1 and rank 20 score nearly the same,
 *   so neither retriever's ordering is trusted very precisely.
 * - Small `k` approaches winner-take-all on each list's top hit.
 *
 * 60 is the value from the original RRF paper and the de-facto default
 * (Elasticsearch, ccsearch, and most hybrid-search implementations use it).
 * At k=60 rank 1 scores 1/61 and rank 20 scores 1/81 — a 1.3x spread.
 *
 * That heavy damping is deliberately right for our inputs: the `titles`
 * list is ordered by RECENCY, not relevance, so its deep ranks carry little
 * signal and must not be treated as precise.
 */
export const RRF_K = 60;

/** One ranked input list, best-first. */
export interface RrfList {
  /**
   * Provenance label, echoed back on the fused result (`topSource`) and
   * used as the key in `ranks`. Must be unique across the lists passed to
   * a single `fuseRrf` call.
   */
  label: string;
  /**
   * Item keys in rank order, BEST FIRST. Position in this array IS the
   * rank — index 0 is rank 1. Duplicate keys are ignored after their first
   * (best) occurrence, so a caller that failed to dedupe can't inflate an
   * item's score by listing it twice.
   */
  keys: string[];
  /**
   * Relative trust in this list. Scales that list's whole contribution.
   * Equal weights (the default) treat both retrievers as equally credible.
   */
  weight?: number;
}

/** One item after fusion. */
export interface RrfResult {
  key: string;
  /**
   * Fused score. Strictly positive, descending-sortable, and NOT a
   * probability or a relevance percentage — only its ORDER is meaningful.
   * Absolute values are small by construction (a single rank-1 hit at
   * weight 1 scores 1/61 ≈ 0.0164). Do not render this as a percentage.
   */
  score: number;
  /** 1-based rank per contributing list, keyed by `RrfList.label`. */
  ranks: Record<string, number>;
  /**
   * Label of the list that contributed the most to `score`. Ties broken by
   * input order — pass the list you want to win ties FIRST.
   */
  topSource: string;
}

/**
 * Fuse ranked lists into one ranking.
 *
 * Lists may overlap, be disjoint, or be empty; an empty list contributes
 * nothing rather than erroring, which is what lets a degraded retriever
 * (no embedding model, FTS unavailable) drop out gracefully instead of
 * taking the whole query down.
 *
 * Results are sorted by score descending. Ties are broken deterministically
 * by key (ascending) so pagination and test assertions are stable — an
 * unstable sort here would make `limit`-truncated results flap between
 * identical queries.
 */
export function fuseRrf(lists: RrfList[], k: number = RRF_K): RrfResult[] {
  const acc = new Map<string, RrfResult & { _best: number }>();

  for (const list of lists) {
    const weight = list.weight ?? 1;
    const seen = new Set<string>();

    for (let i = 0; i < list.keys.length; i++) {
      const key = list.keys[i];
      // First occurrence wins: a duplicated key would otherwise get two
      // contributions from one retriever and outrank genuinely-dual hits.
      if (seen.has(key)) continue;
      seen.add(key);

      const rank = i + 1;
      const contribution = weight / (k + rank);

      let entry = acc.get(key);
      if (!entry) {
        entry = { key, score: 0, ranks: {}, topSource: list.label, _best: -1 };
        acc.set(key, entry);
      }
      entry.score += contribution;
      entry.ranks[list.label] = rank;
      // Strictly-greater keeps the FIRST list to achieve a given
      // contribution as `topSource`, making input order the documented
      // tie-break.
      if (contribution > entry._best) {
        entry._best = contribution;
        entry.topSource = list.label;
      }
    }
  }

  return Array.from(acc.values())
    .map(({ _best, ...r }) => r)
    .sort((a, b) => (b.score - a.score) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
