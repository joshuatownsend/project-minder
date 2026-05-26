/**
 * Catalog token-cost heuristic — shared by the per-row chip on
 * `/agents` and `/skills` (T2.1) and the portfolio context-overhead
 * estimator (`src/lib/contextOverhead.ts`).
 *
 * `BYTES_PER_TOKEN = 4` matches the per-project scanner. Close enough
 * for English text + JSON; will under-count Chinese, code-heavy
 * bodies, etc. We chose a single source of truth over per-call-site
 * tuning so the chip and the /stats portfolio chart can never drift.
 *
 * `DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000` is the Claude Sonnet 4.6
 * / Opus 4.7 (non-1M-variant) default. Per-entry frontmatter `model`
 * could refine this later — see plan note on T2.1.
 */

export const BYTES_PER_TOKEN = 4;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

export function bytesToTokens(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round(bytes / BYTES_PER_TOKEN);
}

export function contextWindowPercent(
  tokens: number,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW_TOKENS,
): number {
  // Mirror `bytesToTokens`'s defensive checks — NaN/Infinity inputs would
  // otherwise propagate through the formatter as `NaN%` / `Infinity%`
  // (PR #166 Copilot review C1).
  if (!Number.isFinite(tokens) || !Number.isFinite(contextWindow)) return 0;
  if (tokens <= 0 || contextWindow <= 0) return 0;
  return (tokens / contextWindow) * 100;
}

/** "~890" / "~1.2k" / "~120k" — for the chip face, intentionally lossy. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return `~${tokens}`;
  if (tokens < 100_000) return `~${(tokens / 1_000).toFixed(1)}k`;
  return `~${Math.round(tokens / 1_000)}k`;
}

/**
 * "0.6%" / "<0.1%". A bare `0.0%` for genuinely-tiny shares reads as
 * "no cost," which is misleading — the chip exists precisely so users
 * notice small-but-real overhead. Floor at `<0.1%`.
 */
export function formatContextWindowPercent(percent: number): string {
  if (percent <= 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

export interface TokenEstimate {
  tokens: number;
  contextWindowPercent: number;
  /** Pre-formatted chip face — e.g. "~1.2k · 0.6%". Null when fileBytes is absent/zero. */
  chipLabel: string;
}

/**
 * Compute the (tokens, %, chipLabel) triple for a catalog row. Returns
 * `null` when `fileBytes` is undefined or zero — the caller should
 * render no chip at all rather than `~0 · 0%`.
 */
export function estimateTokensFromBytes(
  fileBytes: number | undefined,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW_TOKENS,
): TokenEstimate | null {
  if (!fileBytes || fileBytes <= 0) return null;
  const tokens = bytesToTokens(fileBytes);
  if (tokens <= 0) return null;
  const pct = contextWindowPercent(tokens, contextWindow);
  return {
    tokens,
    contextWindowPercent: pct,
    chipLabel: `${formatTokenCount(tokens)} · ${formatContextWindowPercent(pct)}`,
  };
}

/**
 * Format a server-provided `projectedContextCost` field for the per-row
 * chip UI. Returns the chip-face string and a long-form tooltip title,
 * or `null` when the input field is absent — clients render no chip in
 * that case. Mirrors `estimateTokensFromBytes` for the
 * compute-from-bytes path; this is the consume-the-server-field path.
 */
export function formatProjectedContextCost(
  pcc: { tokenEstimate: number; contextWindowPercent: number } | undefined,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW_TOKENS,
): { chipLabel: string; chipTitle: string } | null {
  if (!pcc || pcc.tokenEstimate <= 0) return null;
  // Recompute the percent against the caller-supplied `contextWindow` so
  // the chip label and tooltip stay internally consistent — without this,
  // a caller passing a non-default window would render
  // "...of 100,000-token context window" with a percent computed against
  // 200k (PR #166 Copilot review C2). When the caller uses the default,
  // this recomputes to the same value the server already sent.
  const pct = contextWindowPercent(pcc.tokenEstimate, contextWindow);
  return {
    chipLabel: `${formatTokenCount(pcc.tokenEstimate)} · ${formatContextWindowPercent(pct)}`,
    chipTitle: `~${pcc.tokenEstimate.toLocaleString()} tokens · ${pct.toFixed(2)}% of ${contextWindow.toLocaleString()}-token context window`,
  };
}

/**
 * Enrich a catalog entry with the `projectedContextCost` field for the
 * wire format (REST + MCP). Computed at the API layer rather than at
 * walk time so the context-window denominator can later come from the
 * active model. Returns the entry unchanged when `fileBytes` is missing
 * or rounds to zero tokens — clients render no chip in that case.
 *
 * Pure / non-mutating: produces a new object only when enrichment
 * happens, otherwise returns the input by reference. Generic over the
 * entry shape so AgentEntry and SkillEntry both pass through.
 */
export function withProjectedContextCost<
  T extends {
    fileBytes?: number;
    projectedContextCost?: { tokenEstimate: number; contextWindowPercent: number };
  },
>(entry: T, contextWindow: number = DEFAULT_CONTEXT_WINDOW_TOKENS): T {
  const est = estimateTokensFromBytes(entry.fileBytes, contextWindow);
  if (!est) return entry;
  return {
    ...entry,
    projectedContextCost: {
      tokenEstimate: est.tokens,
      contextWindowPercent: est.contextWindowPercent,
    },
  };
}
