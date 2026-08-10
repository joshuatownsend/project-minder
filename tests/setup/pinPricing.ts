/**
 * Pin model pricing to a committed fixture for the whole suite.
 *
 * Without this, `loadPricing()` resolves its disk cache under
 * `resolveStateDir()`, which falls back to `process.cwd()` — and since
 * `clearStateDirEnv.ts` deletes `MINDER_STATE_DIR`, that is the repo root. Two
 * consequences, both measured rather than assumed:
 *
 *   - Locally the suite read (and the fetch path *wrote*) a 1.2 MB
 *     `.cache/litellm-pricing.json` inside the working tree.
 *   - Anywhere that file is absent — every CI runner, and locally once its 24h
 *     TTL lapses — each `vi.resetModules()` created a fresh module with a fresh
 *     single-flight promise and re-fetched. A full run made **221** requests to
 *     raw.githubusercontent.com.
 *
 * So test pricing depended on a third-party endpoint answering, identically,
 * 221 times under 8 parallel forks. When it didn't, `getModelPricing` quietly
 * returned `FALLBACK_PRICING` instead, and a cost stored at ingest could be
 * priced from a different table than the same turn recomputed live — the
 * exact-ratio parity divergence in #220.
 *
 * The fixture carries the 126 model entries the suite actually names, taken
 * verbatim from LiteLLM, trimmed to the fields `parseLiteLLMEntry` reads
 * (26 KB, not 1.2 MB). Pinning also means an upstream pricing change can no
 * longer turn this suite red on its own.
 *
 * Individual tests that want the fallback table instead can delete the
 * variable in their own scope and restore it — nothing does today.
 */
import path from "path";

process.env.MINDER_PRICING_FILE = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "litellm-pricing.json",
);
