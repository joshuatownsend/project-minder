import { promises as fs } from "fs";
import path from "path";
import type { ModelPricing, UsageTurn } from "@/lib/usage/types";

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
let pricingLoaded = false;

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
  if (pricingLoaded) return;
  pricingLoaded = true;

  try {
    // Check disk cache freshness
    let useDiskCache = false;
    try {
      const stat = await fs.stat(PRICING_CACHE_FILE);
      const ageMs = Date.now() - stat.mtimeMs;
      useDiskCache = ageMs < CACHE_TTL_MS;
    } catch {
      // Cache file doesn't exist
    }

    if (useDiskCache) {
      const data = await fs.readFile(PRICING_CACHE_FILE, "utf-8");
      const raw = JSON.parse(data) as Record<string, unknown>;
      pricingMap = buildPricingMap(raw);
      return;
    }

    // Fetch from LiteLLM
    const response = await fetch(LITELLM_URL);
    if (!response.ok) {
      throw new Error(`LiteLLM fetch failed: ${response.status}`);
    }
    const raw = (await response.json()) as Record<string, unknown>;
    pricingMap = buildPricingMap(raw);

    // Persist to disk cache
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(PRICING_CACHE_FILE, JSON.stringify(raw), "utf-8");
    } catch {
      // Non-critical
    }
  } catch {
    // On any failure, fall back to hardcoded pricing silently
    useFallback();
  }
}

/**
 * Look up pricing for a model by name. Falls back gracefully.
 */
export function getModelPricing(model: string): ModelPricing {
  const map = pricingMap ?? new Map(Object.entries(FALLBACK_PRICING));

  // 1. Exact match
  const exact = map.get(model);
  if (exact) return exact;

  // 2. Fuzzy match: strip date suffix and progressively shorten
  //    e.g. "claude-sonnet-4-5-20250514" → "claude-sonnet-4-5" → "claude-sonnet-4" → ...
  const dateSuffixPattern = /-\d{8}$/;
  let candidate = model.replace(dateSuffixPattern, "");

  while (candidate.length > 0) {
    const match = map.get(candidate);
    if (match) return match;

    // Also try fallback map directly for known keys
    const fallback = FALLBACK_PRICING[candidate];
    if (fallback) return fallback;

    // Strip last dash-separated segment
    const lastDash = candidate.lastIndexOf("-");
    if (lastDash === -1) break;
    candidate = candidate.substring(0, lastDash);
  }

  // 3. Keyword match: opus, sonnet, haiku
  const lower = model.toLowerCase();
  if (lower.includes("opus")) {
    return (
      map.get("claude-opus-4") ??
      FALLBACK_PRICING["claude-opus-4"]
    );
  }
  if (lower.includes("haiku")) {
    return (
      map.get("claude-haiku-3.5") ??
      FALLBACK_PRICING["claude-haiku-3.5"]
    );
  }
  if (lower.includes("sonnet")) {
    return (
      map.get("claude-sonnet-4") ??
      FALLBACK_PRICING["claude-sonnet-4"]
    );
  }

  // 4. Default fallback: sonnet pricing
  return (
    map.get("claude-sonnet-4") ??
    FALLBACK_PRICING["claude-sonnet-4"]
  );
}

/**
 * Compute cost for a single usage turn.
 */
export async function computeTurnCost(turn: UsageTurn): Promise<number> {
  if (!pricingLoaded) {
    await loadPricing();
  }
  const pricing = getModelPricing(turn.model);
  return (
    turn.inputTokens * pricing.inputCostPerToken +
    turn.outputTokens * pricing.outputCostPerToken +
    turn.cacheCreateTokens * pricing.cacheWriteCostPerToken +
    turn.cacheReadTokens * pricing.cacheReadCostPerToken
  );
}

/**
 * Reset module state — for testing only.
 */
export function _resetForTesting(): void {
  pricingMap = null;
  pricingLoaded = false;
}
