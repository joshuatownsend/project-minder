import { promises as fs } from "fs";
import path from "path";
import type { ModelPricing, UsageTurn } from "@/lib/usage/types";
import type { PricingRule } from "@/lib/types";
import { matchPricingRule, applyPricingOverlay } from "@/lib/usage/pricingRules";

// ── Hardcoded fallback pricing (per token) ──────────────────────────────────

const FALLBACK_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4": {
    inputCostPerToken: 0.000015,
    outputCostPerToken: 0.000075,
    cacheWriteCostPerToken: 0.00001875,
    cacheReadCostPerToken: 0.0000015,
  },
  "claude-sonnet-4": {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheWriteCostPerToken: 0.00000375,
    cacheReadCostPerToken: 0.0000003,
  },
  "claude-haiku-3.5": {
    inputCostPerToken: 0.0000008,
    outputCostPerToken: 0.000004,
    cacheWriteCostPerToken: 0.000001,
    cacheReadCostPerToken: 0.00000008,
  },
};

// ── Module-level state ───────────────────────────────────────────────────────

let pricingMap: Map<string, ModelPricing> | null = null;
let pricingLoadPromise: Promise<void> | null = null;

// globalThis so pricing rules survive hot-reload in dev and are shared
// across concurrent requests in production.
declare const globalThis: { __minderPricingRules?: PricingRule[] };

export function setPricingRules(rules: PricingRule[]): void {
  globalThis.__minderPricingRules = rules;
}

export function getPricingRules(): PricingRule[] {
  return globalThis.__minderPricingRules ?? [];
}

// ── Cache paths ──────────────────────────────────────────────────────────────

const CACHE_DIR = path.join(process.cwd(), ".cache");
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
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheWriteCostPerToken: cacheWrite,
    cacheReadCostPerToken: cacheRead,
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
    // 2. Fuzzy match: strip date suffix and progressively shorten
    const dateSuffixPattern = /-\d{8}$/;
    let candidate = model.replace(dateSuffixPattern, "");

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
    // 3. Keyword match: opus, sonnet, haiku
    const lower = model.toLowerCase();
    if (lower.includes("opus")) {
      base = map.get("claude-opus-4") ?? FALLBACK_PRICING["claude-opus-4"];
    } else if (lower.includes("haiku")) {
      base = map.get("claude-haiku-3.5") ?? FALLBACK_PRICING["claude-haiku-3.5"];
    } else if (lower.includes("sonnet")) {
      base = map.get("claude-sonnet-4") ?? FALLBACK_PRICING["claude-sonnet-4"];
    } else {
      // 4. Default fallback: sonnet pricing
      base = map.get("claude-sonnet-4") ?? FALLBACK_PRICING["claude-sonnet-4"];
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

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
}

/**
 * Apply pricing to a token-count tuple. Sync — caller is responsible for
 * having `loadPricing()` resolved (or accepts hardcoded fallbacks).
 *
 * Single source of truth for the cost formula across the file-parse path
 * and the SQLite ingest path. Both must produce identical numbers when
 * P2b switches the read side over.
 */
export function applyPricing(pricing: ModelPricing, tokens: TokenCounts): number {
  return (
    tokens.inputTokens * pricing.inputCostPerToken +
    tokens.outputTokens * pricing.outputCostPerToken +
    tokens.cacheCreateTokens * pricing.cacheWriteCostPerToken +
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
  delete globalThis.__minderPricingRules;
}
