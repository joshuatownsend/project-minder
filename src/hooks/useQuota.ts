"use client";

import { useEffect, useState } from "react";
import type { QuotaResult } from "@/lib/quota";

let quotaCache: QuotaResult | null = null;
let quotaLoadPromise: Promise<QuotaResult | null> | null = null;

async function loadQuotaClient(): Promise<QuotaResult | null> {
  if (quotaCache) return quotaCache;
  if (!quotaLoadPromise) {
    quotaLoadPromise = (async () => {
      try {
        const res = await fetch("/api/integrations/quota");
        if (!res.ok) { quotaLoadPromise = null; return null; }
        const data = (await res.json()) as QuotaResult;
        quotaCache = data;
        return data;
      } catch {
        quotaLoadPromise = null;
        return null;
      }
    })();
  }
  return quotaLoadPromise;
}

export function useQuota(): QuotaResult | null {
  const [quota, setQuota] = useState<QuotaResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadQuotaClient().then((q) => { if (!cancelled) setQuota(q); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return quota;
}
