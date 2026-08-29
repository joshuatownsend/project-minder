"use client";

import { useEffect, useState } from "react";
import type { QuotaResult } from "@/lib/quota";

const QUOTA_CLIENT_TTL = 5 * 60 * 1000;
// Negative results (missing creds, probe failure) retry after a short window so
// a *persistent* poller recovers once the user fixes credentials — instead of
// pinning the failure until a hard reload. Matches the server's FAILURE_TTL_MS.
const QUOTA_FAILURE_TTL = 60 * 1000;

let quotaCache: QuotaResult | null = null;
let quotaFailAt = 0; // when the current negative `quotaCache` was stored
let quotaLoadPromise: Promise<QuotaResult> | null = null;

function cacheFailure(reason: string): QuotaResult {
  const fail = { configured: false as const, reason };
  quotaCache = fail;
  quotaFailAt = Date.now();
  return fail;
}

async function loadQuotaClient(): Promise<QuotaResult> {
  if (quotaCache) {
    if (!quotaCache.configured) {
      // Negative result expires on the short failure TTL (was: never expired),
      // so the HUD's 60s poll can recover after creds are fixed.
      if (Date.now() - quotaFailAt < QUOTA_FAILURE_TTL) return quotaCache;
      quotaCache = null;
    } else {
      const age = Date.now() - new Date(quotaCache.cachedAt).getTime();
      if (age < QUOTA_CLIENT_TTL) return quotaCache;
      quotaCache = null; // expired — allow re-fetch
    }
  }
  if (!quotaLoadPromise) {
    quotaLoadPromise = (async () => {
      try {
        const res = await fetch("/api/integrations/quota");
        if (!res.ok) {
          return cacheFailure(`Quota HTTP ${res.status}`);
        }
        const data = (await res.json()) as QuotaResult;
        // A 200 can still carry `configured: false` (creds missing) — cache it
        // with the failure TTL, not forever.
        if (!data.configured) return cacheFailure(data.reason);
        quotaCache = data;
        return data;
      } catch {
        return cacheFailure("Failed to load quota data");
      } finally {
        quotaLoadPromise = null;
      }
    })();
  }
  return quotaLoadPromise;
}

/**
 * Read the Claude quota snapshot.
 *
 * By default this fetches once on mount — correct for page-scoped callers
 * (Settings) that remount on navigation. Pass `pollMs` for a *persistent*
 * consumer (the top-bar burn HUD stays mounted for the whole SPA session): the
 * hook then re-checks on that cadence, but `loadQuotaClient` only hits the
 * network once its own 5-min TTL lapses, so a 60s poll is almost always a
 * cheap cache read. Polling pauses on a backgrounded tab, matching the app's
 * SSE/poller convention (no work while hidden).
 *
 * `active` (default true) gates all quota work: when false the hook does no
 * fetch, no Anthropic probe, and no poll — so a feature-flag opt-out (or a
 * still-loading config) can prevent the request entirely rather than merely
 * hiding the result. Rules of Hooks forbid calling `useQuota` conditionally, so
 * a gated caller passes the flag in instead of skipping the call.
 */
export function useQuota(pollMs?: number, active: boolean = true): QuotaResult | null {
  return useQuotaState(pollMs, active).quota;
}

/**
 * The same read, with the request's own state instead of an inference from it
 * (#518).
 *
 * `quota === null` was the only signal callers had, and it means THREE things:
 * the request is out, the request failed, and the hook is gated off. Both
 * Settings sections drove a `data-loading` marker from it, so a quota fetch
 * that failed — or a caller that passed `active: false` — pinned the page as
 * busy for every `[data-loading]` consumer, indefinitely.
 *
 * `pending` distinguishes them: it starts true only when the hook will actually
 * fetch, and is cleared when the load settles. `loadQuotaClient` never rejects
 * — it returns a `configured: false` sentinel instead — so "settled" here means
 * resolved, and a failure arrives as data rather than as a throw.
 */
export function useQuotaState(
  pollMs?: number,
  active: boolean = true
): { quota: QuotaResult | null; pending: boolean } {
  const [quota, setQuota] = useState<QuotaResult | null>(null);
  // Gated off means nothing is coming, which is SETTLED, not pending. Reading
  // `active: false` as "still loading" is the same conflation one level up.
  const [pending, setPending] = useState(active);

  useEffect(() => {
    if (!active) {
      setPending(false);
      return; // opt-out / config not yet resolved: do no quota work
    }
    // True at the START of the active branch, not only at declaration. `active`
    // flips false→true when a gating flag or config resolves, and `pollMs` can
    // change — in both cases the first real request was in flight while callers
    // read `pending: false` and rendered "no quota" (Copilot, PR #521).
    setPending(true);
    let cancelled = false;
    const load = () => {
      loadQuotaClient()
        .then((q) => { if (!cancelled) setQuota(q); })
        .finally(() => { if (!cancelled) setPending(false); });
    };
    load();

    if (!pollMs) return () => { cancelled = true; };

    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      load();
    }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollMs, active]);

  return { quota, pending };
}
