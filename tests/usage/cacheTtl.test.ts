import { describe, it, expect } from "vitest";
import { extractCacheCreate1hTokens } from "@/lib/usage/cacheTtl";

describe("extractCacheCreate1hTokens", () => {
  it("reads the 1-hour slice from a real usage object", () => {
    // Shape taken verbatim from a Claude Code transcript.
    const usage = {
      input_tokens: 2,
      cache_creation_input_tokens: 59031,
      cache_read_input_tokens: 25951,
      output_tokens: 443,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 59031,
      },
    };
    expect(extractCacheCreate1hTokens(usage)).toBe(59031);
  });

  it("returns 0 when the breakdown says there were no 1-hour writes", () => {
    const usage = {
      cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
    };
    expect(extractCacheCreate1hTokens(usage)).toBe(0);
  });

  it("returns undefined — not 0 — when there is no breakdown at all", () => {
    // The distinction matters: undefined means "this transcript predates the
    // breakdown", which pricing treats as 5-minute writes. A 0 would be a
    // positive claim that no 1-hour writes happened.
    expect(extractCacheCreate1hTokens({ cache_creation_input_tokens: 100 })).toBeUndefined();
    expect(extractCacheCreate1hTokens({})).toBeUndefined();
  });

  it("tolerates every malformed shape rather than throwing", () => {
    for (const bad of [
      undefined,
      null,
      "not an object",
      42,
      { cache_creation: null },
      { cache_creation: "nope" },
      { cache_creation: {} },
      { cache_creation: { ephemeral_1h_input_tokens: "1000" } },
      { cache_creation: { ephemeral_1h_input_tokens: NaN } },
      { cache_creation: { ephemeral_1h_input_tokens: Infinity } },
      { cache_creation: { ephemeral_1h_input_tokens: -5 } },
    ]) {
      expect(extractCacheCreate1hTokens(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
