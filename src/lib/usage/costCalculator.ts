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
//
// ── The >200k tier: absent ON PURPOSE from every entry but `claude-sonnet-4` ──
//
// Do NOT "fix" the other entries by adding `inputCostPerTokenAbove200k` /
// `outputCostPerTokenAbove200k`. Their absence is an assertion, not an
// oversight. Anthropic's pricing page (checked 2026-08-06) states it directly:
//
//   "Claude 4.6 and later models and Claude Mythos Preview include the full
//    1M token context window at standard pricing. (A 900k-token request is
//    billed at the same per-token rate as a 9k-token request.)"
//
// So Opus 5/4.8/4.7/4.6, Sonnet 5/4.6 and Fable 5 have a 1M window and NO
// surcharge; adding one would over-report every long turn. The tier is real
// only for the Sonnet 3.5→4.5 lineage, whose 1M window shipped as a priced
// beta. LiteLLM agrees: `claude-sonnet-4-5` publishes above-200k rates while
// `claude-sonnet-4-6` and `claude-sonnet-5` do not.
//
// This is why issue #376 — "the fallback publishes no above-200k rates, so the
// tier never applies" — was right about the symptom and wrong about the fix.
// Its proposed remedy (add tiers to every model with a 1M window) would have
// turned a safe under-report into an over-report on the models actually in use.
// A 1M context window does not imply a long-context surcharge.
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
  // Sonnet 4.6 and 5 — $3 / $15, flat across the full 1M window. Split from the
  // `claude-sonnet-4` entry below, which carries identical base rates: the two
  // differ ONLY in whether the long-context tier exists. See the tier note above.
  "claude-sonnet-5": {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheWriteCostPerToken: 0.00000375,
    cacheWrite1hCostPerToken: 0.000006,
    cacheReadCostPerToken: 0.0000003,
  },
  // Sonnet 3.5 / 3.7 / 4 / 4.5 — $3 / $15 base, and the ONLY Claude models in
  // this table with a real >200k tier: their 1M window shipped as a beta opt-in
  // priced at 2x input / 1.5x output ($6 / $22.50). Matches LiteLLM's own
  // `claude-sonnet-4-5` entry exactly.
  //
  // The tier covers the CACHE rates too, and this is the only entry that may
  // carry them — see the derivation recorded on `ModelPricing`. They are the
  // standard multipliers taken against the $6 above-200k input rate rather than
  // the $3 base: read 0.1x = $0.60, 5m write 1.25x = $7.50, 1h write 2x = $12.
  "claude-sonnet-4": {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheWriteCostPerToken: 0.00000375,
    cacheWrite1hCostPerToken: 0.000006,
    cacheReadCostPerToken: 0.0000003,
    inputCostPerTokenAbove200k: 0.000006,
    outputCostPerTokenAbove200k: 0.0000225,
    cacheReadCostPerTokenAbove200k: 0.0000006,
    cacheWriteCostPerTokenAbove200k: 0.0000075,
    cacheWrite1hCostPerTokenAbove200k: 0.000012,
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

// ── Fast-mode pricing ────────────────────────────────────────────────────────
//
// Fast mode (`message.usage.speed === "fast"`) is a premium tier, not a label:
// it bills at DOUBLE the standard rate. Anthropic's pricing page states it
// directly (checked 2026-08-10):
//
//   "Fast mode, in research preview, provides significantly faster output for
//    Claude Opus 5 and Claude Opus 4.8 at premium pricing. Fast mode pricing
//    applies across the full context window, including requests over 200k
//    input tokens. […] Claude Opus 5 / Claude Opus 4.8 — $10 / MTok input,
//    $50 / MTok output. […] Fast mode pricing stacks with other pricing
//    modifiers: prompt caching multipliers apply on top of fast mode pricing."
//
// Hardcoded rather than parsed because LiteLLM carries `supports_speed: true`
// for these models but publishes NO fast rates — there is nothing to read. The
// cache rates below are the standard multipliers against the $10 fast input
// rate: read 0.1x = $1, 5m write 1.25x = $12.50, 1h write 2x = $20. (Sanity
// check: that is exactly the Claude Fable 5 row above, which is also $10/$50.)
//
// No above-200k fields, and that absence is an assertion: the page says fast
// pricing "applies across the full context window", so there is no long-context
// tier to model on top of it.
const FAST_PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": {
    inputCostPerToken: 0.00001,
    outputCostPerToken: 0.00005,
    cacheWriteCostPerToken: 0.0000125,
    cacheWrite1hCostPerToken: 0.00002,
    cacheReadCostPerToken: 0.000001,
  },
};

/**
 * Canonical `FAST_PRICING` key for a model id, or `null` if the model has no
 * fast tier.
 *
 * Deliberately matched on the RAW model id rather than via
 * `resolveClaudeFamily`, which folds every Opus 4.5-and-later id onto the same
 * `claude-opus-5` key. Fast mode is narrower than that family: the pricing page
 * says it is unavailable on Opus 4.7 (a `speed: "fast"` request errors) and
 * that Opus 4.6 "run[s] at standard speed and [is] billed at standard rates".
 * So a family-keyed lookup would invent a doubled rate for two models that can
 * never incur one.
 */
function resolveFastFamily(model: string): string | null {
  const lower = model.toLowerCase();
  // Substring match so dated snapshots (`claude-opus-5-20251101`) resolve too.
  // `opus-4-5` cannot collide with `opus-5`: the ids differ at the `4-`.
  if (lower.includes("opus-5") || lower.includes("opus-4-8")) {
    return "claude-opus-5";
  }
  return null;
}

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
  // Sonnet — one BASE price across 3.5 → 5, but the long-context tier splits
  // the family on the same 4.6 boundary the pricing page draws: 4.6 and later
  // are flat across the full 1M window, 4.5 and earlier carry the priced-beta
  // surcharge. Generation-qualified ids therefore have to resolve before the
  // bare `sonnet` catch-all, exactly as Opus does above — and `sonnet-4-6`
  // before `sonnet-4`, since the former contains the latter.
  ["sonnet-5", "claude-sonnet-5"],
  ["sonnet-4-6", "claude-sonnet-5"],
  ["sonnet-4-5", "claude-sonnet-4"],
  ["sonnet-4", "claude-sonnet-4"],
  ["3-7-sonnet", "claude-sonnet-4"],
  ["3-5-sonnet", "claude-sonnet-4"],
  // Haiku.
  ["haiku-4-5", "claude-haiku-4-5"],
  ["3-5-haiku", "claude-haiku-3.5"],
  ["haiku-3", "claude-haiku-3.5"],
  // Unversioned or future ids inherit the newest known rates for their family.
  ["opus", "claude-opus-5"],
  ["sonnet", "claude-sonnet-5"],
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
  // The same tier applied to the three cache categories (#393). Carried through
  // only where LiteLLM publishes them, so a model without a tier keeps flat
  // cache pricing — `claude-sonnet-4-5` publishes all three, every current
  // Claude publishes none.
  const cacheReadAbove = entry["cache_read_input_token_cost_above_200k_tokens"];
  const cacheWriteAbove = entry["cache_creation_input_token_cost_above_200k_tokens"];
  const cacheWrite1hAbove =
    entry["cache_creation_input_token_cost_above_1hr_above_200k_tokens"];
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheWriteCostPerToken: cacheWrite,
    cacheReadCostPerToken: cacheRead,
    ...(typeof cacheWrite1h === "number" ? { cacheWrite1hCostPerToken: cacheWrite1h } : {}),
    ...(typeof inputAbove === "number" ? { inputCostPerTokenAbove200k: inputAbove } : {}),
    ...(typeof outputAbove === "number" ? { outputCostPerTokenAbove200k: outputAbove } : {}),
    ...(typeof cacheReadAbove === "number" ? { cacheReadCostPerTokenAbove200k: cacheReadAbove } : {}),
    ...(typeof cacheWriteAbove === "number" ? { cacheWriteCostPerTokenAbove200k: cacheWriteAbove } : {}),
    ...(typeof cacheWrite1hAbove === "number"
      ? { cacheWrite1hCostPerTokenAbove200k: cacheWrite1hAbove }
      : {}),
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

    // Pinned pricing: when `MINDER_PRICING_FILE` names a readable JSON file in
    // LiteLLM's schema, it is the whole source of truth — no disk-cache stat,
    // no network, no cache write.
    //
    // This exists because the disk cache lives at `resolveStateDir()/.cache`,
    // and `resolveStateDir()` falls back to `process.cwd()`. Under vitest the
    // suite deletes `MINDER_STATE_DIR` (tests/setup/clearStateDirEnv.ts), so
    // that resolved to the repo root: the suite read — and wrote — a 1.2 MB
    // `.cache/litellm-pricing.json` next to the source. Where it was absent
    // (any CI runner) every `vi.resetModules()` produced a fresh module with a
    // fresh single-flight promise, measured at **221 requests** to
    // raw.githubusercontent.com in one run. Those forks race a rate limiter,
    // so some resolve real rates and others silently take
    // `FALLBACK_PRICING` — which is how a cost stored at ingest and one
    // recomputed live can disagree by an exact model-rate ratio (#220).
    //
    // Read here rather than at module scope on purpose: a module-scope capture
    // is frozen at first import and cannot be isolated per test, which is the
    // failure class #331 was about.
    const pinnedPath = process.env.MINDER_PRICING_FILE;
    if (pinnedPath) {
      try {
        const pinned = await fs.readFile(pinnedPath, "utf-8");
        pricingMap = buildPricingMap(JSON.parse(pinned) as Record<string, unknown>);
      } catch {
        // A named-but-unreadable file is a config error, not a reason to reach
        // for the network the setting exists to avoid.
        useFallback();
      }
      return;
    }

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
 *
 * `speed` is `UsageTurn.speed` — `message.usage.speed`, i.e. `"fast"` or
 * `"standard"` or absent. Only `"fast"`, on a model that has a fast tier,
 * changes anything.
 *
 * **Unknown speed bills standard, deliberately.** Everywhere else in this
 * codebase a null/absent `speed` means "unknown, never assume standard" — the
 * field is nullable on exactly the turns that also lack `effort`. Pricing is
 * the one place that rule inverts: the alternative to assuming standard is
 * assuming a doubled rate on every turn from before the field existed, which
 * would fabricate cost across the whole historical corpus. Under-reporting an
 * unlabelled fast turn is the safe direction, and fast mode is opt-in per
 * request, so absence really is standard far more often than not.
 */
export function getModelPricing(model: string, speed?: string): ModelPricing {
  const map = pricingMap ?? new Map(Object.entries(FALLBACK_PRICING));

  // 0. Fast mode short-circuits the whole resolution chain: LiteLLM publishes
  //    no fast rates, so there is nothing in `map` to find and the fallback
  //    table below would return the STANDARD rate for the same model.
  if (speed === "fast") {
    const fastKey = resolveFastFamily(model);
    if (fastKey) {
      // Rule overlay still applies — a user rule matching this model is saying
      // what the model costs them, and silently exempting fast turns from it
      // would be its own surprise.
      return applyPricingOverlay(
        FAST_PRICING[fastKey],
        matchPricingRule(getPricingRules(), model)
      );
    }
    // A `fast` turn on a model with no fast tier falls through to standard
    // pricing rather than erroring. Opus 4.6 does exactly this at the provider
    // (runs standard, bills standard), so the fall-through is the correct
    // behaviour rather than merely the lenient one.
  }

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
      //
      // Resolves to the FLAT `claude-sonnet-5` entry, not the tiered
      // `claude-sonnet-4` one, for two reasons. First, an unrecognized id should
      // inherit the newest known rates, same principle as the trailing matchers
      // above. Second — and this is the load-bearing one — the `""` sentinel
      // prices an AGGREGATE bucket summed over many turns. Give that bucket a
      // model that publishes a >200k tier and any caller reaching `tier:"auto"`
      // reads the summed input as one enormous prompt and bills the whole bucket
      // long-context. That is the precise regression the base/long bucket split
      // in `computeCostFromPerModel` was added to fix; pointing this default at a
      // tiered entry would re-arm it from the other side.
      base = map.get("claude-sonnet-5") ?? FALLBACK_PRICING["claude-sonnet-5"];
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
 * The 1-hour cache-write rate for a request, given whether it is in the long
 * tier and what the 5-minute rate resolved to.
 *
 * The awkward case, and a real one: LiteLLM's dated Sonnet 4 entries
 * (`claude-sonnet-4-20250514`, `claude-4-sonnet-20250514`) publish a tiered
 * **5-minute** write rate but no tiered **1-hour** one. Falling back to the
 * base 1-hour rate there mixes a tiered rate and a base rate inside a single
 * request, and produces an ordering that cannot exist: base 1h is $6/MTok
 * against a tiered 5m of $7.50/MTok, so the *longer*, always-more-expensive TTL
 * would come out cheaper. A 1-hour write is 2x base input and a 5-minute write
 * 1.25x, so `1h >= 5m` is structural — an implementation that breaks it is
 * wrong on its face, without needing to know either number.
 *
 * So when the tier applies and only the 1-hour tiered rate is missing, it is
 * derived by scaling the base 1-hour rate by the factor the 5-minute rate
 * actually moved. Same technique `applyPricingOverlay` uses for user rules, and
 * it degrades correctly: if no tiered write rate is published at all, the ratio
 * is 1 and cache writes stay flat, which is the per-rate "absent means flat"
 * rule this function otherwise follows.
 */
function resolveCacheWrite1hRate(
  pricing: ModelPricing,
  longContext: boolean,
  cacheWriteRate: number
): number {
  const base1h = pricing.cacheWrite1hCostPerToken;
  if (!longContext) return base1h ?? cacheWriteRate;
  if (pricing.cacheWrite1hCostPerTokenAbove200k !== undefined) {
    return pricing.cacheWrite1hCostPerTokenAbove200k;
  }
  // No 1-hour rate at all → the provider has a single write rate; use the
  // (possibly tiered) 5-minute one rather than inventing a second.
  if (base1h === undefined) return cacheWriteRate;
  const tierRatio =
    pricing.cacheWriteCostPerToken > 0
      ? cacheWriteRate / pricing.cacheWriteCostPerToken
      : 1;
  return base1h * tierRatio;
}

/** The five per-token rates that actually apply to one token tuple. */
export interface EffectiveRates {
  inputRate: number;
  outputRate: number;
  /** Cache writes made at the 5-minute (default) TTL. */
  cacheWriteRate: number;
  /** Cache writes made at the 1-hour TTL. */
  cacheWrite1hRate: number;
  cacheReadRate: number;
}

/**
 * Resolve which rates apply to a token tuple, before any multiplication.
 *
 * Split out of `applyPricing` so that consumers computing something *other*
 * than a bill — the cache rebuild-waste diagnostic in `sessionQuality`, most
 * notably — select rates the same way the bill does instead of reaching for
 * the base fields directly. That divergence is invisible by construction: both
 * numbers look plausible, they are shown on different screens, and only a
 * long-context or fast turn makes them disagree.
 */
export function selectEffectiveRates(
  pricing: ModelPricing,
  tokens: TokenCounts,
  tier: PricingTier = "auto"
): EffectiveRates {
  // Long-context pricing is a per-request TIER selected by prompt size, NOT a
  // marginal per-bucket split. LiteLLM/Anthropic switch the rates based on the
  // request's input (prompt) size: once it exceeds 200k, the ENTIRE request's
  // input AND output are billed at the above-200k rates (A4). An earlier
  // version split each bucket at 200k and left output at the base rate, which
  // undercharged a 250k-input/short-output call vs provider billing.
  // Cache tokens ride the same tier (#393): the tier is a property of the
  // request, and cached tokens are part of the request's prompt. Before that
  // they stayed at base rate, which under-billed the dominant component of
  // exactly the requests the tier exists for — a 5k-input + 220k-cache-read
  // turn is ~98% cache.
  const publishesLongRates =
    pricing.inputCostPerTokenAbove200k !== undefined ||
    pricing.outputCostPerTokenAbove200k !== undefined ||
    pricing.cacheReadCostPerTokenAbove200k !== undefined ||
    pricing.cacheWriteCostPerTokenAbove200k !== undefined ||
    pricing.cacheWrite1hCostPerTokenAbove200k !== undefined;
  // The tier is chosen by the size of the REQUEST'S PROMPT, and cached tokens
  // are part of that prompt. Claude Code reports new uncached input separately
  // from `cache_read_input_tokens`, so a real 225k-token request that hit the
  // cache arrives as ~5k input + ~220k cache read — and testing `inputTokens`
  // alone would never trip the tier on exactly the requests it exists for.
  // `contextAttribution.ts` already treats the same sum as the request's
  // context; this makes the pricing path agree with it.
  const promptTokens =
    tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheCreateTokens;
  const longContext =
    publishesLongRates &&
    (tier === "long" || (tier === "auto" && promptTokens > TIER_BOUNDARY));

  const inputRate =
    longContext && pricing.inputCostPerTokenAbove200k !== undefined
      ? pricing.inputCostPerTokenAbove200k
      : pricing.inputCostPerToken;
  const outputRate =
    longContext && pricing.outputCostPerTokenAbove200k !== undefined
      ? pricing.outputCostPerTokenAbove200k
      : pricing.outputCostPerToken;

  // Each cache rate falls back to its OWN base counterpart when the long-tier
  // variant is absent, rather than to a shared default. That keeps
  // "absent means flat" true per rate, so a model that published, say, only a
  // tiered cache-read rate would not accidentally lift its write rates too.
  // Providers that publish no separate 1-hour rate still keep flat cache-write
  // pricing via the second `??`.
  const cacheWriteRate =
    longContext && pricing.cacheWriteCostPerTokenAbove200k !== undefined
      ? pricing.cacheWriteCostPerTokenAbove200k
      : pricing.cacheWriteCostPerToken;
  const cacheWrite1hRate = resolveCacheWrite1hRate(pricing, longContext, cacheWriteRate);
  const cacheReadRate =
    longContext && pricing.cacheReadCostPerTokenAbove200k !== undefined
      ? pricing.cacheReadCostPerTokenAbove200k
      : pricing.cacheReadCostPerToken;

  return { inputRate, outputRate, cacheWriteRate, cacheWrite1hRate, cacheReadRate };
}

/**
 * Split `cacheCreateTokens` into its 1-hour and 5-minute portions.
 *
 * Claude Code writes at the 1-hour TTL, so on its transcripts the 1-hour slice
 * is effectively the whole total — treating it all as 5-minute understates
 * cache-write cost by ~37%. Clamped to the total so a malformed breakdown can
 * never charge more 1-hour tokens than were written.
 */
export function splitCacheCreate(tokens: TokenCounts): {
  cacheCreate1h: number;
  cacheCreate5m: number;
} {
  const cacheCreate1h = Math.min(
    Math.max(tokens.cacheCreate1hTokens ?? 0, 0),
    tokens.cacheCreateTokens
  );
  return { cacheCreate1h, cacheCreate5m: tokens.cacheCreateTokens - cacheCreate1h };
}

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
  const rates = selectEffectiveRates(pricing, tokens, tier);
  const { cacheCreate1h, cacheCreate5m } = splitCacheCreate(tokens);

  return (
    tokens.inputTokens * rates.inputRate +
    tokens.outputTokens * rates.outputRate +
    cacheCreate5m * rates.cacheWriteRate +
    cacheCreate1h * rates.cacheWrite1hRate +
    tokens.cacheReadTokens * rates.cacheReadRate
  );
}

/**
 * Compute cost for a single usage turn.
 */
export async function computeTurnCost(turn: UsageTurn): Promise<number> {
  if (!pricingMap) {
    await loadPricing();
  }
  return applyPricing(getModelPricing(turn.model, turn.speed), turn);
}

/**
 * Same as {@link computeTurnCost} but synchronous, for callers that have
 * already awaited {@link loadPricing} and need to price many turns in a tight
 * loop.
 *
 * The async variant awaits `loadPricing()` on every call, which is a no-op
 * once resolved but still forces the caller's loop to be async — serializing
 * tens of thousands of turns through the microtask queue for no benefit. This
 * exists so a bulk accumulation can stay a plain `for`.
 *
 * **Contract:** call `loadPricing()` first. If pricing has not loaded,
 * `getModelPricing` still returns the hardcoded fallback table, so this
 * degrades to offline rates rather than throwing or returning 0 — the same
 * behaviour every other pre-`loadPricing` caller already gets.
 */
export function computeTurnCostSync(turn: UsageTurn): number {
  return applyPricing(getModelPricing(turn.model, turn.speed), turn);
}

/**
 * Reset module state — for testing only.
 */
export function _resetForTesting(): void {
  pricingMap = null;
  pricingLoadPromise = null;
  delete g.__minderPricingRules;
}
