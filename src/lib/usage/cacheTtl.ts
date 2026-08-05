/**
 * Extraction of the prompt-cache TTL breakdown Claude reports on each turn.
 *
 * `usage.cache_creation_input_tokens` is a single total, but the two cache TTLs
 * bill at different rates — 1.25x base input for the 5-minute default, 2x for
 * the 1-hour TTL. Claude Code writes its cache at the 1-hour TTL, so pricing the
 * total at the 5-minute rate understates cache-write cost by roughly a third.
 * The per-TTL split lives in a sibling `usage.cache_creation` object:
 *
 * ```json
 * "cache_creation_input_tokens": 59031,
 * "cache_creation": { "ephemeral_1h_input_tokens": 59031, "ephemeral_5m_input_tokens": 0 }
 * ```
 */

/** The `usage.cache_creation` sub-object, when a transcript carries one. */
export interface CacheCreationBreakdown {
  ephemeral_1h_input_tokens?: number;
  ephemeral_5m_input_tokens?: number;
}

/**
 * Pull the 1-hour-TTL slice out of a turn's `usage` object.
 *
 * Takes `unknown` and narrows at runtime so every caller can hand over its own
 * `usage` value regardless of how that call site happens to type it — the three
 * JSONL readers (usage parser, DB ingest, conversation scanner) each declare
 * their own entry shape, and none of them should have to agree on one.
 *
 * Returns `undefined` — not `0` — when there is no breakdown to read, so
 * pricing can tell "no 1-hour writes" apart from "this transcript predates the
 * breakdown" and fall back to charging the whole total at the 5-minute rate.
 */
export function extractCacheCreate1hTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const breakdown = (usage as { cache_creation?: unknown }).cache_creation;
  if (!breakdown || typeof breakdown !== "object") return undefined;
  const raw = (breakdown as CacheCreationBreakdown).ephemeral_1h_input_tokens;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return undefined;
  return raw;
}
