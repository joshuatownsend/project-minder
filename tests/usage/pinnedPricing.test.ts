import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

/**
 * `MINDER_PRICING_FILE` — the seam that lets pricing be pinned to a file
 * instead of resolved from the disk cache or the network.
 *
 * It exists because the pricing disk cache resolves under
 * `resolveStateDir()`, which is `MINDER_STATE_DIR || process.cwd()`. The suite
 * deletes `MINDER_STATE_DIR`, so under vitest that was the repo root: tests
 * read and wrote a 1.2 MB `.cache/litellm-pricing.json` in the working tree,
 * and wherever it was absent (every CI runner) each `vi.resetModules()` made a
 * fresh single-flight promise and re-fetched — 221 requests to
 * raw.githubusercontent.com in one measured run.
 *
 * The property that matters most is the second test: a pin that cannot be read
 * must NOT fall through to the network. A pin that silently reaches for
 * LiteLLM would reintroduce exactly the nondeterminism it was added to remove,
 * and would do it invisibly.
 */

let tmpHome: string;
// Saved and restored one key at a time, rather than by looping a key list.
// `dbIsolationGuard` reads these as literal `process.env.X` sites, and a loop
// over a key array is invisible to it — it flagged the loop version of this
// file as leaking all four variables. The guard is right to be conservative
// there, so the file matches the shape it can verify (as longContextTier does).
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalStateDir: string | undefined;
let originalPricingFile: string | undefined;

/** A model id absent from both LiteLLM's real table and FALLBACK_PRICING, so
 *  seeing its rate proves the pinned file is what was read. */
const PINNED_ONLY_MODEL = "totally-made-up-model-v9";
const PINNED_RATE = 0.000123;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalStateDir = process.env.MINDER_STATE_DIR;
  originalPricingFile = process.env.MINDER_PRICING_FILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-pinprice-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // Point the disk cache away from the repo root, so "did it read the pin?"
  // can't be answered by a stale real cache instead.
  process.env.MINDER_STATE_DIR = tmpHome;
});

afterEach(async () => {
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

/** Fresh module + a fetch that records any call and then fails. */
async function freshPricing() {
  vi.resetModules();
  const fetchCalls: string[] = [];
  vi.stubGlobal("fetch", (...a: unknown[]) => {
    fetchCalls.push(String(a[0]));
    return Promise.reject(new Error("network should not be reached"));
  });
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  const mod = await import("@/lib/usage/costCalculator");
  return { mod, fetchCalls };
}

describe("MINDER_PRICING_FILE", () => {
  it("serves rates from the pinned file and never touches the network", async () => {
    const pinned = path.join(tmpHome, "pinned.json");
    await fs.writeFile(
      pinned,
      JSON.stringify({ [PINNED_ONLY_MODEL]: { input_cost_per_token: PINNED_RATE, output_cost_per_token: 0 } }),
      "utf-8",
    );
    process.env.MINDER_PRICING_FILE = pinned;

    const { mod, fetchCalls } = await freshPricing();
    await mod.loadPricing();

    expect(mod.getModelPricing(PINNED_ONLY_MODEL).inputCostPerToken).toBe(PINNED_RATE);
    expect(fetchCalls).toEqual([]);
  });

  it("falls back rather than reaching the network when the pinned file is unreadable", async () => {
    // The failure mode this guards: a bad pin quietly restoring the very
    // network dependency the setting removes.
    process.env.MINDER_PRICING_FILE = path.join(tmpHome, "does-not-exist.json");

    const { mod, fetchCalls } = await freshPricing();
    await mod.loadPricing();

    expect(fetchCalls).toEqual([]);
    // Fallback table is in play: a known Claude id prices, the invented one doesn't.
    expect(mod.getModelPricing("claude-sonnet-4-5").inputCostPerToken).toBeGreaterThan(0);
    expect(mod.getModelPricing(PINNED_ONLY_MODEL).inputCostPerToken).toBe(0);
  });

  it("still uses the network path when nothing is pinned", async () => {
    // Guards the converse: the branch must be opt-in, or the suite-wide pin in
    // tests/setup/pinPricing.ts would be masking a permanently dead fetch path.
    delete process.env.MINDER_PRICING_FILE;

    const { mod, fetchCalls } = await freshPricing();
    await mod.loadPricing();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("litellm");
  });
});
