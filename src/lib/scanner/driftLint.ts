import type { MinderConfig, LintFinding } from "../types";
import { getFlag } from "../featureFlags";
import { collectInventories } from "../drift/inventory";
import { detectDrift } from "../drift/compare";

/**
 * One-shot cross-harness drift pass, run once per scan alongside
 * `runCatalogLint`. Emits `target: "drift"` findings into the same lint
 * report the Config Lint panel already renders, rather than standing up a
 * parallel page and API for a handful of advisory rows.
 *
 * Gated by `configDrift` (default on). Even enabled it costs nothing for the
 * common case: with the default `enabledAdapters` of `["claude"]` there is
 * only one harness to inventory, and `detectDrift` returns immediately.
 *
 * Non-fatal by construction — any failure yields an empty array. A parity
 * observation must never be able to fail a scan.
 */
export async function runDriftLint(
  config: MinderConfig,
): Promise<LintFinding[]> {
  if (!getFlag(config.featureFlags, "configDrift", true)) return [];

  try {
    const enabled = config.enabledAdapters ?? ["claude"];
    // Nothing to compare against — skip the filesystem work entirely rather
    // than inventorying Claude just to discard it.
    if (!enabled.includes("codex") && !enabled.includes("gemini")) return [];

    const inventories = await collectInventories(enabled);
    return detectDrift(inventories);
  } catch {
    return [];
  }
}
