import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

/**
 * Issue #376 — the offline pricing fallback and the long-context tier.
 *
 * The issue reported that `FALLBACK_PRICING` publishes no above-200k rates, so
 * the tier never applies when pricing resolves offline. That was true. Its
 * proposed fix — add the rates to every entry with a 1M context window — was
 * not: Anthropic's pricing page states that Claude 4.6 and later include the
 * full 1M window *at standard pricing*. Applying a surcharge there would turn a
 * safe under-report into an over-report on exactly the models in daily use.
 *
 * So these tests pin BOTH directions:
 *   - the Sonnet 3.5→4.5 lineage, whose 1M window shipped as a priced beta,
 *     must publish the tier offline (the reported bug);
 *   - Sonnet 4.6+/Opus 4.6+/Fable 5 must NOT (the fix that was almost made).
 *
 * Every test forces the offline path by making `fetch` reject, since the whole
 * subject is what happens when LiteLLM is unreachable.
 */

const TIERED_MODEL = "claude-sonnet-4-5-20250929";
const FLAT_MODEL = "claude-sonnet-5";

// Sonnet base rates, per token.
const IN_BASE = 0.000003;
const OUT_BASE = 0.000015;
// Priced-beta long-context rates: 2x input, 1.5x output.
const IN_LONG = 0.000006;
const OUT_LONG = 0.0000225;

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalStateDir: string | undefined;
let originalPricingFile: string | undefined;

async function freshPricing() {
  vi.resetModules();
  // Force the offline branch of `loadPricing()`.
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return import("@/lib/usage/costCalculator");
}

/**
 * Pricing rules live on `globalThis`, which `vi.resetModules()` does NOT clear.
 * Without this, the overlay test below leaks a half-price rule into every later
 * test in the file — and the failure it produces (a `pattern.replace` TypeError
 * deep inside `matchPricingRule`) points at the victim, not the culprit.
 */
function clearPricingRules(): void {
  delete (globalThis as { __minderPricingRules?: unknown }).__minderPricingRules;
}

beforeEach(async () => {
  clearPricingRules();
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalStateDir = process.env.MINDER_STATE_DIR;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-tier-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // `resolveStateDir()` is `MINDER_STATE_DIR || process.cwd()`, NOT a homedir
  // lookup — so stubbing HOME alone still lets `loadPricing()` find the repo's
  // real `.cache/litellm-pricing.json` and serve live rates. Without this the
  // offline assertions silently test LiteLLM's table instead of the fallback,
  // which is the one thing these tests exist to pin.
  process.env.MINDER_STATE_DIR = tmpHome;
  // The suite pins pricing to a committed LiteLLM fixture
  // (tests/setup/pinPricing.ts) so no test depends on the network. That pin
  // short-circuits `loadPricing()` *before* the fetch — which is precisely the
  // branch this file exists to exercise. Opt out for the duration of each
  // case, so a rejected `fetch` still lands on `FALLBACK_PRICING`.
  originalPricingFile = process.env.MINDER_PRICING_FILE;
  delete process.env.MINDER_PRICING_FILE;
});

afterEach(async () => {
  clearPricingRules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalStateDir === undefined) delete process.env.MINDER_STATE_DIR;
  else process.env.MINDER_STATE_DIR = originalStateDir;
  if (originalPricingFile === undefined) delete process.env.MINDER_PRICING_FILE;
  else process.env.MINDER_PRICING_FILE = originalPricingFile;
  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
});

describe("#376 — which models publish an above-200k tier offline", () => {
  it("the Sonnet 4.5 lineage does, so the tier can actually fire", async () => {
    const { getModelPricing, loadPricing } = await freshPricing();
    await loadPricing();
    const pricing = getModelPricing(TIERED_MODEL);
    // The reported bug: these were both undefined, so `applyPricing`'s
    // `publishesLongRates` guard was never satisfied on the offline path.
    expect(pricing.inputCostPerTokenAbove200k).toBe(IN_LONG);
    expect(pricing.outputCostPerTokenAbove200k).toBe(OUT_LONG);
    expect(pricing.inputCostPerToken).toBe(IN_BASE);
  });

  it("Claude 4.6 and later do NOT, despite having 1M windows", async () => {
    const { getModelPricing, loadPricing, getModelMaxContextTokens } = await freshPricing();
    await loadPricing();
    // Every one of these has a 1M context window...
    for (const model of ["claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-5", "claude-opus-4-8", "claude-fable-5"]) {
      expect(getModelMaxContextTokens(model)).toBe(1_000_000);
      // ...and none of them carries a surcharge for using it.
      const pricing = getModelPricing(model);
      expect(pricing.inputCostPerTokenAbove200k).toBeUndefined();
      expect(pricing.outputCostPerTokenAbove200k).toBeUndefined();
    }
  });

  it("a 250k-token Sonnet 5 prompt is billed flat, not at 2x", async () => {
    // This is the regression #376's suggested fix would have introduced. It is
    // asserted as a dollar amount rather than as an absent field so it keeps
    // failing even if the tier is reintroduced by some other route.
    const { getModelPricing, applyPricing, loadPricing } = await freshPricing();
    await loadPricing();
    const cost = applyPricing(getModelPricing(FLAT_MODEL), {
      inputTokens: 250_000,
      outputTokens: 1_000,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    });
    expect(cost).toBeCloseTo(250_000 * IN_BASE + 1_000 * OUT_BASE, 10);
    // Explicitly NOT the surcharged figure.
    expect(cost).not.toBeCloseTo(250_000 * IN_LONG + 1_000 * OUT_LONG, 10);
  });

  it("an unrecognized Claude id inherits flat rates, not the tiered lineage", async () => {
    // The `""` sentinel prices an aggregate bucket in the file-parse path, so
    // giving it a tiered model would re-arm the summed-bucket overcharge from
    // the other side.
    const { getModelPricing, loadPricing } = await freshPricing();
    await loadPricing();
    for (const id of ["", "claude-something-unreleased"]) {
      const pricing = getModelPricing(id);
      expect(pricing.inputCostPerToken).toBe(IN_BASE);
      expect(pricing.inputCostPerTokenAbove200k).toBeUndefined();
    }
  });
});

describe("#376 — pricing rule overlay scales the tier with the override", () => {
  it("halving the input price halves the above-200k rate too", async () => {
    const { getModelPricing, loadPricing, setPricingRules } = await freshPricing();
    await loadPricing();
    setPricingRules([
      {
        pattern: "claude-sonnet-4-5*",
        // Half of Sonnet's $3/$15 per-MTok base.
        inputUsdPerMillion: 1.5,
        outputUsdPerMillion: 7.5,
      },
    ]);
    const pricing = getModelPricing(TIERED_MODEL);
    expect(pricing.inputCostPerToken).toBeCloseTo(IN_BASE / 2, 12);
    // Unscaled, this would still read $6/MTok — leaving the override applying
    // to sub-200k prompts only, and the "discounted" long rate at 4x the
    // discounted base.
    expect(pricing.inputCostPerTokenAbove200k).toBeCloseTo(IN_LONG / 2, 12);
    expect(pricing.outputCostPerTokenAbove200k).toBeCloseTo(OUT_LONG / 2, 12);
    // The 2x/1.5x shape of the tier survives the override.
    expect(pricing.inputCostPerTokenAbove200k! / pricing.inputCostPerToken).toBeCloseTo(2, 10);
  });
});

// ── End-to-end through the scanner ───────────────────────────────────────────

interface JsonlEntry {
  type: string;
  timestamp: string;
  message?: unknown;
}

async function writeSession(
  projectsDir: string,
  encodedDir: string,
  entries: JsonlEntry[]
): Promise<void> {
  const file = path.join(projectsDir, encodedDir, "11111111-4444-4444-4444-444455556666.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function assistant(id: string, model: string, inputTokens: number, outputTokens: number): JsonlEntry {
  return {
    type: "assistant",
    timestamp: "2026-04-15T10:00:00Z",
    message: {
      id,
      model,
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  };
}

/**
 * The coverage gap #376 called out: because no fallback model published tiered
 * rates, an end-to-end test through the scanner could not exercise the tier at
 * all. It can now — and what it needs to prove is the regression the
 * `base`/`long` bucket split exists to prevent, where an aggregate bucket's
 * summed input trips the tier and overcharges every ordinary turn in it.
 */
describe("#376 — scanner prices per-request tiers, not per-bucket sums", () => {
  it("many sub-200k turns stay at base rates even though their sum exceeds 200k", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    await writeSession(projectsDir, "C--dev-tier-x", [
      assistant("m1", TIERED_MODEL, 150_000, 1_000),
      assistant("m2", TIERED_MODEL, 150_000, 1_000),
      assistant("m3", TIERED_MODEL, 150_000, 1_000),
    ]);

    const { scanClaudeConversations } = await import("@/lib/scanner/claudeConversations");
    const stats = await scanClaudeConversations("C:\\dev\\tier-x");

    const perTurn = 150_000 * IN_BASE + 1_000 * OUT_BASE;
    expect(stats?.costEstimate).toBeCloseTo(perTurn * 3, 8);
    // The bug this guards: 450k summed input read as one long request.
    expect(stats?.costEstimate).not.toBeCloseTo(450_000 * IN_LONG + 3_000 * OUT_LONG, 8);
  });

  it("selects the tier on the whole prompt, including cached tokens", async () => {
    // Codex review of #383. Claude Code reports new uncached input separately
    // from cache reads, so a real 225k-token request that hit the cache looks
    // like 5k input + 220k cache read. Testing `inputTokens` alone never trips
    // the tier on exactly the requests the tier exists for.
    const { getModelPricing, applyPricing, loadPricing } = await freshPricing();
    await loadPricing();
    // Cache reads ride the tier too, since #393 — 0.1x of the $6 above-200k
    // input rate, not of the $3 base. This assertion used to name the BASE
    // cache-read rate and passed, which is how it came to ratify the very
    // defect #393 reports: it pinned the tier as reaching input and output
    // only, on the one turn shape where cache is ~98% of the bill.
    const CACHE_READ_LONG = 0.0000006;
    const cost = applyPricing(getModelPricing(TIERED_MODEL), {
      inputTokens: 5_000,
      outputTokens: 1_000,
      cacheCreateTokens: 0,
      cacheReadTokens: 220_000,
    });
    expect(cost).toBeCloseTo(
      5_000 * IN_LONG + 1_000 * OUT_LONG + 220_000 * CACHE_READ_LONG,
      10,
    );
    expect(cost).not.toBeCloseTo(
      5_000 * IN_BASE + 1_000 * OUT_BASE + 220_000 * CACHE_READ_LONG,
      10,
    );
  });

  it("still leaves a small cached request on the base tier", async () => {
    const { getModelPricing, applyPricing, loadPricing } = await freshPricing();
    await loadPricing();
    const CACHE_READ = 0.0000003;
    const cost = applyPricing(getModelPricing(TIERED_MODEL), {
      inputTokens: 5_000,
      outputTokens: 1_000,
      cacheCreateTokens: 0,
      cacheReadTokens: 20_000,
    });
    expect(cost).toBeCloseTo(5_000 * IN_BASE + 1_000 * OUT_BASE + 20_000 * CACHE_READ, 10);
  });

  it("a genuinely-long turn on the same model IS billed at the tier", async () => {
    // The mirror assertion. Without it the test above passes trivially if the
    // tier is broken end-to-end rather than merely bucketed correctly.
    vi.resetModules();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    await writeSession(projectsDir, "C--dev-tier-y", [
      assistant("m1", TIERED_MODEL, 250_000, 1_000),
    ]);

    const { scanClaudeConversations } = await import("@/lib/scanner/claudeConversations");
    const stats = await scanClaudeConversations("C:\\dev\\tier-y");

    expect(stats?.costEstimate).toBeCloseTo(250_000 * IN_LONG + 1_000 * OUT_LONG, 8);
  });

  it("the same long turn on a 4.6+ model is billed flat", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    await writeSession(projectsDir, "C--dev-tier-z", [
      assistant("m1", FLAT_MODEL, 250_000, 1_000),
    ]);

    const { scanClaudeConversations } = await import("@/lib/scanner/claudeConversations");
    const stats = await scanClaudeConversations("C:\\dev\\tier-z");

    expect(stats?.costEstimate).toBeCloseTo(250_000 * IN_BASE + 1_000 * OUT_BASE, 8);
  });
});
