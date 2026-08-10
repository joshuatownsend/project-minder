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
 * variable in their own scope and restore it — `tests/usage/longContextTier`
 * does, because forcing the offline branch is its whole subject.
 *
 * ## Regenerating the fixture
 *
 * It was extracted from a live LiteLLM table by keeping the model ids the
 * suite names and the fields `parseLiteLLMEntry` reads. To refresh it (e.g. to
 * add a model a new test uses), from the repo root with a current
 * `.cache/litellm-pricing.json`:
 *
 * ```js
 * const raw = JSON.parse(fs.readFileSync(".cache/litellm-pricing.json", "utf8"));
 * const want = /^(claude-|gpt-5|gpt-4|gemini-1\.5-pro$|gemini-2\.0-flash$|gemini-2\.5-flash$|gemini-3)/;
 * const FIELDS = ["input_cost_per_token", "output_cost_per_token",
 *   "cache_read_input_token_cost", "cache_creation_input_token_cost",
 *   "cache_creation_input_token_cost_above_1hr",
 *   "input_cost_per_token_above_200k_tokens",
 *   "output_cost_per_token_above_200k_tokens",
 *   "cache_read_input_token_cost_above_200k_tokens",
 *   "cache_creation_input_token_cost_above_200k_tokens",
 *   "cache_creation_input_token_cost_above_1hr_above_200k_tokens",
 *   "max_input_tokens", "max_tokens"];
 * // keep entries matching `want`, projected onto FIELDS → tests/fixtures/litellm-pricing.json
 * // JSON.stringify(out, null, 1), no trailing newline — matches the committed file.
 * ```
 *
 * **The projection is load-bearing, and silently so.** A field missing from
 * `FIELDS` is not a smaller fixture — it is a pricing feature the pinned suite
 * can never exercise. The three `*_above_200k_tokens` cache fields were absent
 * until #393 added them here, which meant no test could have caught that
 * `applyPricing` left cache tokens at base rate in the long tier. If you add a
 * rate to `ModelPricing`, add its LiteLLM field to this list in the same
 * change.
 *
 * A model id outside the fixture is not an error: `getModelPricing` falls
 * through to `FALLBACK_PRICING`, which is how the suite behaved before this
 * existed. It is silent, though — so if a cost assertion is ever mysteriously
 * zero for a non-Claude model, check whether the id is in the fixture first.
 */
import path from "path";

process.env.MINDER_PRICING_FILE = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "litellm-pricing.json",
);
