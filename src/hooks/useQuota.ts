"use client";

import { useEffect, useState } from "react";
import type { QuotaResult } from "@/lib/quota";

const QUOTA_CLIENT_TTL = 5 * 60 * 1000;

let quotaCache: QuotaResult | null = null;
let quotaLoadPromise: Promise<QuotaResult> | null = null;

async function loadQuotaClient(): Promise<QuotaResult> {
  if (quotaCache) {
    if (!quotaCache.configured) return quotaCache; // errors don't expire (user must reload)
    const age = Date.now() - new Date(quotaCache.cachedAt).getTime();
    if (age < QUOTA_CLIENT_TTL) return quotaCache;
    quotaCache = null; // expired — allow re-fetch
  }
  if (!quotaLoadPromise) {
    quotaLoadPromise = (async () => {
      try {
        const res = await fetch("/api/integrations/quota");
        if (!res.ok) {
          return { configured: false as const, reason: `Quota HTTP ${res.status}` };
        }
        const data = (await res.json()) as QuotaResult;
        quotaCache = data;
        return data;
      } catch {
        return { configured: false as const, reason: "Failed to load quota data" };
      } finally {
        quotaLoadPromise = null;
      }
    })();
  }
  return quotaLoadPromise;
}

export function useQuota(): QuotaResult | null {
  const [quota, setQuota] = useState<QuotaResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadQuotaClient().then((q) => { if (!cancelled) setQuota(q); });
    return () => { cancelled = true; };
  }, []);

  return quota;
}
