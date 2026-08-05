import { promises as fs } from "fs";
import path from "path";
import type { ModelPricing, UsageTurn } from "@/lib/usage/types";
import type { PricingRule } from "@/lib/types";
import { matchPricingRule, applyPricingOverlay } from "@/lib/usage/pricingRules";
import { resolveStateDir } from "@/lib/serverRoot";

// ── Hardcoded fallback pricing (per token) ──────────────────────────────────

// Rates are per token = ($ per MTok) / 1e6, transcribed from
// https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-08-04).
// Every Claude family charges cache writes at 1.25x base for the 5-minute TTL
// and 2x base for the 1-hour TTL, and cache reads at 0.1x base.
//
// This table is the OFFLINE path only — `loadPricing()` prefers LiteLLM and
// falls back here when the network and the disk cache are both unavailable. It
// still has to be right: the same map backs `getModelPricing` before
// `loadPricing()` resolves, and a stale table silently misprices every model
// rather than failing loudly.
//
// Deliberately using Claude Sonnet 5's STANDARD $3/$15 rather than the
// introductory $2/$10 that runs through 2026-08-31. The intro rate would be
// more accurate for a few more weeks and then wrong forever; LiteLLM tracks the
// live rate on the online path, so the durable number belongs here.
const FALLBACK_PRICING: Record<string, ModelPricing> = {
  // Fable / Mythos tier — $10 / $50
  "claude-fable-5": {
    inputCostPerToken: 0.00001,
    outputCostPerToken: 0.00005,
    cacheWriteCostPerToken: 0.0000125,
    cacheWrite1hCostPerToken: 0.00002,
    cacheReadCostPerToken: 0.000001,
  },
  // Opus 4.5 and later — $5 / $25
  "claude-opus-5": {
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.000025,
    cacheWriteCostPerToken: 0.00000625,
    cacheWrite1hCostPerToken: 0.00001,
    cacheReadCostPerToken: 0.0000005,
  },
  // Opus 4 / 4.1 / Opus 3 — the older $15 / $75 generation. Kept under the bare
  // `claude-opus-4` key it has always used so existing rules and tests still
  // resolve; `resolveClaudeFamily` routes only genuinely-old ids here.
  "claude-opus-4": {
    inputCostPerToken: 0.000015,
    outputCostPerToken: 0.000075,
    cacheWriteCostPerToken: 0.00001875,
    cacheWrite1hCostPerToken: 0.00003,
    cacheReadCostPerToken: 0.0000015,
  },
  // Every Sonnet generation from 3.5 through 5 — $3 / $15
  "claude-sonnet-4": {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheWriteCostPerToken: 0.00000375,
    cacheWrite1hCostPerToken: 0.000006,
    cacheReadCostPerToken: 0.0000003,
  },
  "claude-haiku-4-5": {
    inputCostPerToken: 0.000001,
    outputCostPerToken: 0.000005,
    cacheWriteCostPerToken: 0.00000125,
    cacheWrite1hCostPerToken: 0.000002,
    cacheReadCostPerToken: 0.0000001,
  },
  "claude-haiku-3.5": {
    inputCostPerToken: 0.0000008,
    outputCostPerToken: 0.000004,
    cacheWriteCostPerToken: 0.000001,
    cacheWrite1hCostPerToken: 0.0000016,
    cacheReadCostPerToken: 0.00000008,
  },
};

/**
 * Claude model id → canonical `FALLBACK_PRICING` key, matched by substring and
 * evaluated **in order, most specific first**.
 *
 * Order is load-bearing, and it is the whole reason this table exists rather
 * than a plain map. Model ids nest: `claude-opus-4-8` contains `opus-4`, so a
 * naive scan (or the progressive-shortening loop in `getModelPricing` step 3)
 * resolves an Opus 4.8 turn to the Opus 4 entry and bills it at $15/$75 instead
 * of $5/$25 — a 3x overcharge on the current default model. Matching 4.8/4.7/
 * 4.6/4.5 before the bare `opus-4` fixes that, and the trailing generic entries
 * mean an id newer than this table (`claude-opus-6`, say) inherits the newest
 * known rates instead of the oldest.
 */
const CLAUDE_FAMILY_MATCHERS: ReadonlyArray<readonly [string, string]> = [
  // Fable / Mythos share a tier and a price.
  ["fable-5", "claude-fable-5"],
  ["mythos", "claude-fable-5"],
  // Opus, newest first.
  ["opus-5", "claude-opus-5"],
  ["opus-4-8", "claude-opus-5"],
  ["opus-4-7", "claude-opus-5"],
  ["opus-4-6", "claude-opus-5"],
  ["opus-4-5", "claude-opus-5"],
  ["opus-4-1", "claude-opus-4"],
  ["3-opus", "claude-opus-4"],
  ["opus-4", "claude-opus-4"],
  // Sonnet — one price across 3.5 → 5, so every id lands on the same entry.
  ["sonnet", "claude-sonnet-4"],
  // Haiku.
  ["haiku-4-5", "claude-haiku-4-5"],
  ["3-5-haiku", "claude-haiku-3.5"],
  ["haiku-3", "claude-haiku-3.5"],
  // Unversioned or future ids inherit the newest known rates for their family.
  ["opus", "claude-opus-5"],
  ["haiku", "claude-haiku-4-5"],
  ["fable", "claude-fable-5"],
];

/**
 * Resolve any Claude model id to a canonical `FALLBACK_PRICING` key, or null
 * when the id is not recognisably Claude. Used by `getModelPricing` only —
 * `getModelMaxContextTokens` deliberately keeps its own table, because pricing
 * and context windows group models differently (see
 * `CLAUDE_MAX_CONTEXT_MATCHERS`).
 */
function resolveClaudeFamily(model: string): string | null {
  const lower = model.toLowerCase();
  for (const [token, key] of CLAUDE_FAMILY_MATCHERS) {
    if (lower.includes(token)) return key;
  }
  return null;
}

// Zero-cost pricing for an unknown NON-Claude model id. Returned instead of the
// Claude Sonnet default so an unpriceable `gpt-*` / `gemini-*` id surfaces as a
// visible $0 ("unknown") in the By-Source / By-Model breakdowns rather than a
// fabricated Claude-rate cost. See `getModelPricing` step 4b.
const UNKNOWN_PRICING: ModelPricing = {
  inputCostPerToken: 0,
  outputCostPerToken: 0,
  cacheWriteCostPerToken: 0,
  cacheReadCostPerToken: 0,
};

// ── Module-level state ───────────────────────────────────────────────────────

let pricingMap: Map<string, ModelPricing> | null = null;
let pricingLoadPromise: Promise<void> | null = null;

// globalThis so pricing rules survive hot-reload in dev and are shared
// across concurrent requests in production.
const g = globalThis as unknown as { __minderPricingRules?: PricingRule[] };

export function setPricingRules(rules: PricingRule[]): void {
  g.__minderPricingRules = rules;
}

export function getPricingRules(): PricingRule[] {
  return g.__minderPricingRules ?? [];
}

// ── Cache paths ──────────────────────────────────────────────────────────────

const CACHE_DIR = path.join(resolveStateDir(), ".cache");
const PRICING_CACHE_FILE = path.join(CACHE_DIR, "litellm-pricing.json");
const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseLiteLLMEntry(entry: Record<string, unknown>): ModelPricing {
  const input = (entry["input_cost_per_token"] as number) ?? 0;
  const output = (entry["output_cost_per_token"] as number) ?? 0;
  const cacheRead =
    (entry["cache_read_input_token_cost"] as number) ?? input * 0.1;
  const cacheWrite =
    (entry["cache_creation_input_token_cost"] as number) ?? input * 1.25;
  // 1-hour-TTL cache writes bill at 2x base where the provider offers the
  // longer TTL. Carried through only when LiteLLM publishes it, so a model
  // with a single write rate keeps flat cache-write pricing.
  const cacheWrite1h = entry["cache_creation_input_token_cost_above_1hr"];
  // Tiered >200k pricing (Claude 1M-context / long-context surcharge). Only
  // carried through when LiteLLM actually publishes the field for this model,
  // so models without a tier keep flat pricing. See A4.
  const inputAbove = entry["input_cost_per_token_above_200k_tokens"];
  const outputAbove = entry["output_cost_per_token_above_200k_tokens"];
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheWriteCostPerToken: cacheWrite,
    cacheReadCostPerToken: cacheRead,
    ...(typeof cacheWrite1h === "number" ? { cacheWrite1hCostPerToken: cacheWrite1h } : {}),
    ...(typeof inputAbove === "number" ? { inputCostPerTokenAbove200k: inputAbove } : {}),
    ...(typeof outputAbove === "number" ? { outputCostPerTokenAbove200k: outputAbove } : {}),
  };
}

function buildPricingMap(
  raw: Record<string, unknown>
): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const [modelName, entry] of Object.entries(raw)) {
    if (entry && typeof entry === "object") {
      try {
        map.set(modelName, parseLiteLLMEntry(entry as Record<string, unknown>));
      } catch {
        // Skip malformed entries
      }
    }
  }
  return map;
}

function useFallback(): void {
  pricingMap = new Map(Object.entries(FALLBACK_PRICING));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load pricing from LiteLLM (with disk cache). Called lazily.
 */
export async function loadPricing(): Promise<void> {
  if (pricingMap) return;
  if (pricingLoadPromise) return pricingLoadPromise;

  pricingLoadPromise = (async () => {
    // Warm pricing rules from config so they survive server restarts.
    try {
      const { readConfig } = await import("@/lib/config");
      const config = await readConfig();
      if (config.pricingRules?.length) setPricingRules(config.pricingRules);
    } catch { /* non-critical */ }

    try {
      let useDiskCache = false;
      try {
        const stat = await fs.stat(PRICING_CACHE_FILE);
        useDiskCache = Date.now() - stat.mtimeMs < CACHE_TTL_MS;
      } catch {
        // Cache file doesn't exist
      }

      if (useDiskCache) {
        const data = await fs.readFile(PRICING_CACHE_FILE, "utf-8");
        pricingMap = buildPricingMap(JSON.parse(data) as Record<string, unknown>);
        return;
      }

      const response = await fetch(LITELLM_URL);
      if (!response.ok) throw new Error(`LiteLLM fetch failed: ${response.status}`);
      const raw = (await response.json()) as Record<string, unknown>;
      pricingMap = buildPricingMap(raw);

      try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await fs.writeFile(PRICING_CACHE_FILE, JSON.stringify(raw), "utf-8");
      } catch {
        // Non-critical
      }
    } catch {
      useFallback();
    }
  })();

  return pricingLoadPromise;
}

/**
 * Look up pricing for a model by name. Falls back gracefully.
 * Applies any active pricing rule overlay before returning.
 */
export function getModelPricing(model: string): ModelPricing {
  const map = pricingMap ?? new Map(Object.entries(FALLBACK_PRICING));

  // 1. Exact match
  let base = map.get(model);

  if (!base) {
    // 2. Strip a trailing date suffix and retry exactly. A bare
    //    `claude-opus-4-8` is a real LiteLLM key, so this catches the dated
    //    snapshots without any generation-guessing.
    const dateSuffixPattern = /-\d{8}$/;
    const undated = model.replace(dateSuffixPattern, "");
    if (undated !== model) base = map.get(undated) ?? FALLBACK_PRICING[undated];
  }

  if (!base) {
    // 3. Claude family match, most-specific-first. This runs BEFORE the
    //    progressive-shortening loop below on purpose: shortening walks
    //    `claude-opus-4-8` → `claude-opus-4`, which is a real key for the older
    //    $15/$75 generation, so it would resolve a current Opus turn to triple
    //    its true rate. `resolveClaudeFamily` pins the generation first.
    const family = resolveClaudeFamily(model);
    if (family) base = map.get(family) ?? FALLBACK_PRICING[family];
  }

  if (!base) {
    // 4. Progressive shortening, for non-Claude ids (`gpt-4o-mini-2024-07-18`
    //    → `gpt-4o-mini` → `gpt-4o`). Claude ids never reach here — step 3
    //    matches every one of them, or they are not Claude at all.
    let candidate = model.replace(/-\d{8}$/, "");
    while (candidate.length > 0) {
      const match = map.get(candidate);
      if (match) { base = match; break; }
      const fallback = FALLBACK_PRICING[candidate];
      if (fallback) { base = fallback; break; }
      const lastDash = candidate.lastIndexOf("-");
      if (lastDash === -1) break;
      candidate = candidate.substring(0, lastDash);
    }
  }

  if (!base) {
    const lower = model.toLowerCase();
    if (lower.includes("claude") || model.trim() === "") {
      // 5a. Unrecognized Claude-family id (no opus/sonnet/haiku/fable keyword,
      // not in any map), OR the empty-string sentinel. The file-parse path maps
      // its per-model "unknown" bucket (cache-hit rows with no per-model token
      // attribution) to `getModelPricing("")` and documents it as the Sonnet
      // estimate (`claudeConversations.ts` computeCostFromPerModel / cache-hit
      // accumulation). So `""` is a Claude sentinel — keep Sonnet, never $0.
      base = map.get("claude-sonnet-4") ?? FALLBACK_PRICING["claude-sonnet-4"];
    } else {
      // 5b. Unknown NON-Claude model. Pricing is genuinely unknown — return
      // zero rather than silently billing it at Claude Sonnet rates. A visible
      // $0 ("unknown") is honest; a fabricated Claude-rate cost is not. When
      // online, LiteLLM supplies real OpenAI/Google pricing via the exact/fuzzy
      // match above, so this branch only hits unlisted ids (e.g. a gpt-*/
      // gemini-* id while serving the Claude-only offline fallback). Users can
      // still override via a pricing rule (applied below).
      base = UNKNOWN_PRICING;
    }
  }

  // Apply pricing rule overlay (user-defined overrides from settings)
  const rules = getPricingRules();
  if (rules.length > 0) {
    const rule = matchPricingRule(rules, model);
    return applyPricingOverlay(base, rule);
  }

  return base;
}

/**
 * Context window per Claude generation, matched by substring, **most specific
 * first** for the same nesting reason as `CLAUDE_FAMILY_MATCHERS`.
 *
 * Deliberately a separate table rather than a lookup keyed off
 * `resolveClaudeFamily`: the two group models differently. Opus 4.5 through
 * Opus 5 all bill at $5/$25 and share one pricing entry, but 4.5 is a 200k
 * model and 4.6-and-later are 1M. Sonnet is the same story across 4.5 → 4.6.
 * Reusing the pricing grouping here would report 1M for an Opus 4.5 turn.
 *
 * Everything from Claude 4.6 onward ships the full 1M window at standard
 * pricing (https://platform.claude.com/docs/en/about-claude/pricing).
 */
const CLAUDE_MAX_CONTEXT_MATCHERS: ReadonlyArray<readonly [string, number]> = [
  ["fable-5", 1_000_000],
  ["mythos", 1_000_000],
  ["opus-5", 1_000_000],
  ["opus-4-8", 1_000_000],
  ["opus-4-7", 1_000_000],
  ["opus-4-6", 1_000_000],
  ["opus-4-5", 200_000],
  ["opus-4", 200_000],
  ["3-opus", 200_000],
  ["sonnet-5", 1_000_000],
  ["sonnet-4-6", 1_000_000],
  ["sonnet-4-5", 200_000],
  ["sonnet-4", 200_000],
  ["sonnet", 200_000],
  ["haiku", 200_000],
  // Unversioned or future ids inherit the newest known window.
  ["opus", 1_000_000],
  ["fable", 1_000_000],
];

/**
 * Return the max input-token context window for a model.
 * Uses substring matching so it works for versioned IDs like `claude-opus-4-7`.
 */
export function getModelMaxContextTokens(model: string): number {
  const lower = model.toLowerCase();
  // LiteLLM appends [1m] or :1m for 1M-context variants (e.g. claude-sonnet-4-5[1m]),
  // which opt a 200k-default model into the long-context tier.
  if (lower.includes("[1m]") || lower.includes(":1m")) return 1_000_000;
  for (const [token, size] of CLAUDE_MAX_CONTEXT_MATCHERS) {
    if (lower.includes(token)) return size;
  }
  return 200_000; // safe fallback for any unknown model
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  /**
   * Portion of `cacheCreateTokens` written at the 1-hour TTL (2x base) rather
   * than the 5-minute default (1.25x). A subset of the total, not an addition
   * to it. Optional so every existing caller keeps its current behaviour: when
   * omitted, the whole total bills at the 5-minute rate as before.
   */
  cacheCreate1hTokens?: number;
  cacheReadTokens: number;
}

/** Prompt-size threshold that selects the long-context pricing tier. */
export const TIER_BOUNDARY = 200_000;

/**
 * Which long-context tier to bill a `TokenCounts` at.
 *
 * - `auto` (default) — infer from `tokens.inputTokens`. Correct **only** when
 *   the tuple is a single request, which is what every per-turn caller passes.
 * - `base` / `long` — force the tier. A caller holding a tuple that is a *sum*
 *   of several requests must say which tier those requests were in, because
 *   `auto` would read the summed input as one enormous prompt and bill the
 *   whole bucket long-context once the running total crossed 200k.
 */
export type PricingTier = "auto" | "base" | "long";

/**
 * Apply pricing to a token-count tuple. Sync — caller is responsible for
 * having `loadPricing()` resolved (or accepts hardcoded fallbacks).
 *
 * Single source of truth for the cost formula across the file-parse path
 * and the SQLite ingest path. Both must produce identical numbers when
 * P2b switches the read side over.
 */
export function applyPricing(
  pricing: ModelPricing,
  tokens: TokenCounts,
  tier: PricingTier = "auto"
): number {
  // Long-context pricing is a per-request TIER selected by prompt size, NOT a
  // marginal per-bucket split. LiteLLM/Anthropic switch the rates based on the
  // request's input (prompt) size: once it exceeds 200k, the ENTIRE request's
  // input AND output are billed at the above-200k rates (A4). An earlier
  // version split each bucket at 200k and left output at the base rate, which
  // undercharged a 250k-input/short-output call vs provider billing.
  // Cache tokens stay at their base rate — ModelPricing doesn't carry
  // cache above-200k rates today.
  const publishesLongRates =
    pricing.inputCostPerTokenAbove200k !== undefined ||
    pricing.outputCostPerTokenAbove200k !== undefined;
  const longContext =
    publishesLongRates &&
    (tier === "long" || (tier === "auto" && tokens.inputTokens > TIER_BOUNDARY));

  const inputRate =
    longContext && pricing.inputCostPerTokenAbove200k !== undefined
      ? pricing.inputCostPerTokenAbove200k
      : pricing.inputCostPerToken;
  const outputRate =
    longContext && pricing.outputCostPerTokenAbove200k !== undefined
      ? pricing.outputCostPerTokenAbove200k
      : pricing.outputCostPerToken;

  // Cache writes have two rates, selected by the TTL the write was made with:
  // 1.25x base for the 5-minute default, 2x for the 1-hour TTL. Claude Code
  // writes at the 1-hour TTL, so on its transcripts `cacheCreate1hTokens` is
  // effectively the whole total — billing it at the 5-minute rate understates
  // cache-write cost by ~37%. Clamp to the total so a malformed breakdown can
  // never bill more 1-hour tokens than were written.
  const cacheCreate1h = Math.min(
    Math.max(tokens.cacheCreate1hTokens ?? 0, 0),
    tokens.cacheCreateTokens
  );
  const cacheCreate5m = tokens.cacheCreateTokens - cacheCreate1h;
  // Providers that publish no separate 1-hour rate keep flat cache-write pricing.
  const cacheWrite1hRate =
    pricing.cacheWrite1hCostPerToken ?? pricing.cacheWriteCostPerToken;

  return (
    tokens.inputTokens * inputRate +
    tokens.outputTokens * outputRate +
    cacheCreate5m * pricing.cacheWriteCostPerToken +
    cacheCreate1h * cacheWrite1hRate +
    tokens.cacheReadTokens * pricing.cacheReadCostPerToken
  );
}

/**
 * Compute cost for a single usage turn.
 */
export async function computeTurnCost(turn: UsageTurn): Promise<number> {
  if (!pricingMap) {
    await loadPricing();
  }
  return applyPricing(getModelPricing(turn.model), turn);
}

/**
 * Reset module state — for testing only.
 */
export function _resetForTesting(): void {
  pricingMap = null;
  pricingLoadPromise = null;
  delete g.__minderPricingRules;
}
