import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadQuota, _resetForTesting } from "@/lib/quota";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Module-level fs mock — mirrors fxRates.test.ts pattern
// ---------------------------------------------------------------------------
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      stat: vi.fn(),
      readFile: vi.fn(),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

const mockedFs = vi.mocked(fs.promises);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Credentials file content with a token that expires far in the future. */
function validCredsJson(overrides: Partial<{
  accessToken: string;
  expiresAt: number;
  subscriptionType: string;
  rateLimitTier: string;
}> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-test-token",
      expiresAt: Date.now() + 3_600_000, // 1 hour from now
      subscriptionType: "claude_pro",
      rateLimitTier: "standard_2024_10",
      ...overrides,
    },
  });
}

/** Build a valid QuotaData disk-cache entry. */
const FAKE_QUOTA_DATA = {
  configured: true as const,
  subscriptionType: "claude_pro",
  rateLimitTier: "standard_2024_10",
  overallStatus: "allowed",
  representativeClaim: "five_hour",
  fallbackPercentage: 0,
  windows: {
    "5h": { utilization: 0.42, status: "allowed", reset: 1_700_000_000, resetAt: "2023-11-14T22:13:20.000Z" },
    "7d": { utilization: 0.1, status: "allowed", reset: 1_700_000_000, resetAt: "2023-11-14T22:13:20.000Z" },
    overage: { utilization: 0, status: "allowed", reset: 0, resetAt: "" },
  },
  cachedAt: "2023-11-14T22:00:00.000Z",
};

const FAKE_DISK_CACHE = JSON.stringify({ data: FAKE_QUOTA_DATA });

/** Build response Headers containing the minimal unified rate-limit headers. */
function makeQuotaHeaders(statusOverride = "allowed") {
  return new Headers({
    "anthropic-ratelimit-unified-5h-reset": "1700000000",
    "anthropic-ratelimit-unified-5h-utilization": "0.42",
    "anthropic-ratelimit-unified-5h-status": statusOverride,
    "anthropic-ratelimit-unified-7d-reset": "1700000000",
    "anthropic-ratelimit-unified-7d-utilization": "0.10",
    "anthropic-ratelimit-unified-7d-status": statusOverride,
    "anthropic-ratelimit-unified-overage-reset": "0",
    "anthropic-ratelimit-unified-overage-utilization": "0",
    "anthropic-ratelimit-unified-overage-status": statusOverride,
    "anthropic-ratelimit-unified-status": statusOverride,
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-fallback-percentage": "0",
  });
}

/**
 * Mock fs.readFile to dispatch on path suffix.
 *   - Paths containing ".credentials.json" → return credentialsPayload (or throw).
 *   - Paths containing "quota-cache.json"  → return cachePayload (or throw).
 */
function mockReadFile(
  credentialsPayload: string | Error,
  cachePayload: string | Error = new Error("ENOENT"),
) {
  mockedFs.readFile.mockImplementation(async (p) => {
    const pStr = String(p);
    if (pStr.includes(".credentials.json")) {
      if (credentialsPayload instanceof Error) throw credentialsPayload;
      return credentialsPayload as string;
    }
    if (pStr.includes("quota-cache.json")) {
      if (cachePayload instanceof Error) throw cachePayload;
      return cachePayload as string;
    }
    throw new Error(`Unexpected readFile path: ${pStr}`);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("quota", () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. No credentials file
  // -------------------------------------------------------------------------
  it("returns configured:false when credentials file is missing", async () => {
    mockReadFile(new Error("ENOENT"));

    const result = await loadQuota();

    expect(result).toEqual({
      configured: false,
      reason: "No valid Claude OAuth credentials in ~/.claude/.credentials.json",
    });
  });

  // -------------------------------------------------------------------------
  // 2. Expired token
  // -------------------------------------------------------------------------
  it("returns configured:false when OAuth token is expired", async () => {
    mockReadFile(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-expired",
          expiresAt: Date.now() - 1000, // already expired
          subscriptionType: "claude_pro",
          rateLimitTier: "standard_2024_10",
        },
      }),
    );

    const result = await loadQuota();

    expect(result).toEqual({
      configured: false,
      reason: "No valid Claude OAuth credentials in ~/.claude/.credentials.json",
    });
  });

  // -------------------------------------------------------------------------
  // 3. Fresh disk cache hit — no fetch
  // -------------------------------------------------------------------------
  it("returns cached QuotaData from disk without fetching when cache is fresh", async () => {
    mockReadFile(validCredsJson(), FAKE_DISK_CACHE);
    mockedFs.stat.mockResolvedValue({ mtimeMs: Date.now() - 1_000 } as import("fs").Stats);

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const result = await loadQuota();

    expect(result).toMatchObject({ configured: true, subscriptionType: "claude_pro" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. Successful probe (200 + headers present)
  // -------------------------------------------------------------------------
  it("returns QuotaData from a successful probe on cache miss", async () => {
    // Credentials OK, no fresh disk cache
    mockReadFile(validCredsJson(), new Error("ENOENT"));
    mockedFs.stat.mockRejectedValue(new Error("ENOENT"));

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ type: "message" }), {
        status: 200,
        headers: makeQuotaHeaders(),
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await loadQuota();

    expect(result).toMatchObject({
      configured: true,
      subscriptionType: "claude_pro",
      rateLimitTier: "standard_2024_10",
      overallStatus: "allowed",
    });
    const quota = result as import("@/lib/quota").QuotaData;
    expect(quota.windows["5h"].utilization).toBeCloseTo(0.42);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // 5. Non-2xx probe with headers (throttled / 429)
  //    P1 fix: headers present on 429 → should return configured:true
  // -------------------------------------------------------------------------
  it("returns configured:true data when probe returns 429 but includes unified headers", async () => {
    mockReadFile(validCredsJson(), new Error("ENOENT"));
    mockedFs.stat.mockRejectedValue(new Error("ENOENT"));

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: makeQuotaHeaders("throttled"),
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await loadQuota();

    expect(result).toMatchObject({ configured: true });
    const quota = result as import("@/lib/quota").QuotaData;
    expect(quota.overallStatus).toBe("throttled");
    expect(quota.windows["5h"].status).toBe("throttled");
  });

  // -------------------------------------------------------------------------
  // 6. Probe fails (no headers), stale disk cache exists
  //    NOTE: This test encodes the intended spec. It currently fails in prod
  //    because `if (data)` is truthy for string returns from probe — the stale
  //    cache fallback branch is dead code. Fix: change the guard to
  //    `if (typeof data !== "string")`.
  // -------------------------------------------------------------------------
  it("falls back to stale disk cache when probe returns no headers", async () => {
    // Credentials OK; stat throws so fresh cache path is skipped
    mockReadFile(validCredsJson(), FAKE_DISK_CACHE);
    mockedFs.stat.mockRejectedValue(new Error("ENOENT"));

    // Probe returns HTTP 500 with no unified headers
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 500, headers: new Headers() }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await loadQuota();

    expect(result).toMatchObject({ configured: true, subscriptionType: "claude_pro" });
  });

  // -------------------------------------------------------------------------
  // 7. Negative caching (FAILURE_TTL_MS = 60s)
  //    After a failed probe with no stale cache, a second call within 60s
  //    should return the cached failure without making another fetch call.
  //    NOTE: This test encodes the intended spec. The second-call short-circuit
  //    currently returns the raw error string stored in memData (not the
  //    {configured:false} object) due to the same `if (data)` truthy bug.
  //    Fix is the same as scenario 6.
  // -------------------------------------------------------------------------
  it("does not re-probe within FAILURE_TTL_MS after a failure with no stale cache", async () => {
    mockReadFile(validCredsJson(), new Error("ENOENT"));
    mockedFs.stat.mockRejectedValue(new Error("ENOENT"));

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 500, headers: new Headers() }),
    );
    vi.stubGlobal("fetch", mockFetch);

    // First call — probe fails, negative cache is populated
    const first = await loadQuota();
    expect(first).toMatchObject({ configured: false });

    // Clear the call count so we can assert the second call doesn't fetch again.
    // Do NOT call _resetForTesting() here — that would wipe memFailure.
    mockFetch.mockClear();

    // Second call — should short-circuit via memFailure within FAILURE_TTL_MS
    const second = await loadQuota();
    expect(second).toMatchObject({ configured: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8. In-flight deduplication
  // -------------------------------------------------------------------------
  it("deduplicates concurrent loadQuota() calls to a single fetch", async () => {
    mockReadFile(validCredsJson(), new Error("ENOENT"));
    mockedFs.stat.mockRejectedValue(new Error("ENOENT"));

    // Use a deferred promise so both calls are concurrent while fetch is pending
    let resolveFetch!: (v: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const mockFetch = vi.fn().mockReturnValue(fetchPromise);
    vi.stubGlobal("fetch", mockFetch);

    // Fire two concurrent calls before fetch resolves
    const p1 = loadQuota();
    const p2 = loadQuota();

    // Now let fetch complete
    resolveFetch(
      new Response(null, {
        status: 200,
        headers: makeQuotaHeaders(),
      }),
    );

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toMatchObject({ configured: true });
    expect(r2).toMatchObject({ configured: true });
    // Only a single fetch despite two concurrent callers
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
