import { promises as fs } from "fs";
import path from "path";
import os from "os";

const CREDENTIALS_FILE = path.join(os.homedir(), ".claude", ".credentials.json");
const CACHE_FILE = path.join(os.homedir(), ".minder", "quota-cache.json");
const CACHE_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 60_000;
// Cheapest available model — probe costs ~$0.00001 per call.
const PROBE_MODEL = "claude-haiku-4-5-20251001";

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    expiresAt: number;
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

export interface QuotaWindow {
  utilization: number; // 0.0–1.0
  status: string;      // "allowed" | "throttled"
  reset: number;       // Unix seconds
  resetAt: string;     // ISO 8601
}

export interface QuotaData {
  configured: true;
  subscriptionType: string;
  rateLimitTier: string;
  overallStatus: string;
  representativeClaim: string;
  fallbackPercentage: number;
  windows: {
    "5h": QuotaWindow;
    "7d": QuotaWindow;
    overage: QuotaWindow;
  };
  cachedAt: string;
}

export type QuotaResult = QuotaData | { configured: false; reason: string };

interface DiskEntry {
  data: QuotaData;
}

let memData: QuotaData | null = null;
let memStoredAt = 0;
let memFailure: { configured: false; reason: string } | null = null;
let memFailedAt = 0;
let loadPromise: Promise<QuotaResult> | null = null;

async function readToken(): Promise<{
  token: string;
  subscriptionType: string;
  rateLimitTier: string;
} | null> {
  try {
    const raw = await fs.readFile(CREDENTIALS_FILE, "utf-8");
    const creds = JSON.parse(raw) as ClaudeCredentials;
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (Date.now() > oauth.expiresAt) return null;
    return {
      token: oauth.accessToken,
      subscriptionType: oauth.subscriptionType ?? "unknown",
      rateLimitTier: oauth.rateLimitTier ?? "unknown",
    };
  } catch {
    return null;
  }
}

function parseWindow(headers: Headers, key: string): QuotaWindow {
  const util = parseFloat(headers.get(`anthropic-ratelimit-unified-${key}-utilization`) ?? "NaN");
  const reset = parseInt(headers.get(`anthropic-ratelimit-unified-${key}-reset`) ?? "0", 10);
  return {
    utilization: isNaN(util) ? 0 : util,
    status: headers.get(`anthropic-ratelimit-unified-${key}-status`) ?? "unknown",
    reset,
    resetAt: reset ? new Date(reset * 1000).toISOString() : "",
  };
}

async function probe(
  token: string,
  subscriptionType: string,
  rateLimitTier: string
): Promise<QuotaData | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "0" }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;
    // Verify unified headers are present (API key auth won't return them).
    if (!res.headers.has("anthropic-ratelimit-unified-5h-reset")) return null;

    return {
      configured: true,
      subscriptionType,
      rateLimitTier,
      overallStatus: res.headers.get("anthropic-ratelimit-unified-status") ?? "unknown",
      representativeClaim: res.headers.get("anthropic-ratelimit-unified-representative-claim") ?? "five_hour",
      fallbackPercentage: parseFloat(
        res.headers.get("anthropic-ratelimit-unified-fallback-percentage") ?? "0"
      ),
      windows: {
        "5h": parseWindow(res.headers, "5h"),
        "7d": parseWindow(res.headers, "7d"),
        overage: parseWindow(res.headers, "overage"),
      },
      cachedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function fail(reason: string): { configured: false; reason: string } {
  const r = { configured: false as const, reason };
  memFailure = r;
  memFailedAt = Date.now();
  return r;
}

export async function loadQuota(): Promise<QuotaResult> {
  if (memData && Date.now() - memStoredAt < CACHE_TTL_MS) return memData;
  if (memFailure && Date.now() - memFailedAt < FAILURE_TTL_MS) return memFailure;
  if (loadPromise) return loadPromise;

  loadPromise = (async (): Promise<QuotaResult> => {
    try {
      const tokenInfo = await readToken();
      if (!tokenInfo) {
        return fail("No valid Claude OAuth credentials in ~/.claude/.credentials.json");
      }

      // Fresh disk cache
      try {
        const stat = await fs.stat(CACHE_FILE);
        if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
          const raw = await fs.readFile(CACHE_FILE, "utf-8");
          const entry = JSON.parse(raw) as DiskEntry;
          memData = entry.data;
          memStoredAt = Date.now();
          return entry.data;
        }
      } catch { /* no fresh cache */ }

      const data = await probe(tokenInfo.token, tokenInfo.subscriptionType, tokenInfo.rateLimitTier);

      if (data) {
        memData = data;
        memStoredAt = Date.now();
        try {
          await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
          await fs.writeFile(CACHE_FILE, JSON.stringify({ data }), "utf-8");
        } catch { /* non-critical */ }
        return data;
      }

      // Probe failed — try stale disk cache as last-good fallback.
      try {
        const raw = await fs.readFile(CACHE_FILE, "utf-8");
        const entry = JSON.parse(raw) as DiskEntry;
        return entry.data;
      } catch { /* no stale cache */ }

      return fail("Quota probe returned no unified rate-limit headers");
    } catch (err) {
      return fail(String(err));
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

export function _resetForTesting(): void {
  memData = null;
  memStoredAt = 0;
  memFailure = null;
  memFailedAt = 0;
  loadPromise = null;
}
