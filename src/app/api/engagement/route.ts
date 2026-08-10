import { NextRequest, NextResponse } from "next/server";
import { validatePeriod } from "@/lib/usage/constants";
import { getEngagement, DbUnavailableError } from "@/lib/data";
import { computeETag, ifNoneMatch, jsonWithETag } from "@/lib/httpCache";
import { getOrCreateRouteCache } from "@/lib/routeCache";
import { resolveEngagementConfig } from "@/lib/engagement/config";
import type { EngagementReport } from "@/lib/engagement/types";
import { demoMode } from "@/lib/demo/demoMode";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { normalizePathKey } from "@/lib/platform";

const CACHE_TTL = 2 * 60_000;

interface Slot {
  report: EngagementReport;
  maxMtime: number;
  /**
   * When this slot was computed. Rides in the ETag because every period here
   * is time-dependent — the rolling windows move continuously and `today`
   * rolls at local midnight — so the report legitimately changes while no
   * transcript file is touched and `maxMtime` never advances. Without it a
   * revalidating browser would 304 against a stale timecard until some
   * unrelated file changed. `/api/usage` carries the same field for the same
   * reason (issue #190).
   */
  cachedAt: number;
}

const cache = getOrCreateRouteCache<Slot>("engagement", { ttlMs: CACHE_TTL });

/**
 * Resolve the report timezone.
 *
 * Timecards are filed in local calendar days, so this is load-bearing, not
 * cosmetic — bucketing an evening's work in UTC pushes it onto tomorrow's row
 * for anyone west of Greenwich. An invalid or unknown zone falls back to the
 * server's own rather than silently to UTC, which would be wrong in the same
 * direction while looking deliberate.
 */
function resolveTimeZone(requested: string | null): string {
  const server = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (!requested) return server;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: requested }).format(0);
    return requested;
  } catch {
    return server;
  }
}

/** Minutes → ms, ignoring junk so `resolveEngagementConfig` applies defaults. */
function minutesParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n * 60_000 : undefined;
}

export async function GET(request: NextRequest) {
  // Demo mode serves synthetic fixtures for every read surface, and this one
  // has no fixtures — the report is reconstructed from real transcript
  // timings, which is precisely what a screenshot or demo must not show. It
  // declines rather than falling through to real billable hours.
  if (await demoMode()) {
    return NextResponse.json(
      {
        error: "engagement-unavailable",
        message: "The engagement report isn't available in demo mode.",
        reason: "demo-mode",
      },
      { status: 503 }
    );
  }

  const config_ = await readConfig();
  if (!getFlag(config_.featureFlags, "engagementReport")) {
    return NextResponse.json(
      {
        error: "engagement-unavailable",
        message: "The engagement report is turned off in Settings.",
        reason: "flag-off",
      },
      { status: 503 }
    );
  }

  const params = request.nextUrl.searchParams;
  const period = validatePeriod(params.get("period") || "30d");
  const project = params.get("project") || undefined;
  const timeZone = resolveTimeZone(params.get("tz"));
  // Claude-home discriminator (#311). Re-normalized defensively so a
  // hand-typed `\\wsl$\...` or mixed-case value still matches the
  // `normalizePathKey` form the session stamps use.
  const rawHome = params.get("home") || undefined;
  const home = rawHome ? normalizePathKey(rawHome) : undefined;

  // Thresholds ride on the query string so the UI can recompute live while the
  // user tunes them — the whole "is 15 minutes right?" question is settled by
  // letting them watch the number move, not by arguing about the default.
  const config = resolveEngagementConfig({
    responseThresholdMs: minutesParam(params.get("responseMinutes")),
    runCapMs: minutesParam(params.get("runCapMinutes")),
    tailCreditMs: minutesParam(params.get("tailMinutes")),
  });

  const cacheKey = [
    period, project ?? "all", home ?? "all", timeZone,
    config.responseThresholdMs, config.runCapMs, config.tailCreditMs,
  ].join(":");

  let slot = cache.get(cacheKey);
  if (!slot) {
    try {
      const { report, meta } = await getEngagement(period, timeZone, config, project, home);
      slot = { report, maxMtime: meta.maxMtimeMs, cachedAt: Date.now() };
      cache.set(cacheKey, slot);
    } catch (error) {
      if (error instanceof DbUnavailableError) {
        return NextResponse.json(
          {
            error: "engagement-unavailable",
            message: error.message,
            reason: error.reason,
          },
          { status: 503 }
        );
      }
      throw error;
    }
  }

  // The thresholds are part of the ETag: two requests differing only in
  // `responseMinutes` describe different reports over identical source bytes,
  // so keying on mtime alone would serve a 304 with the wrong number.
  // `cachedAt` bounds staleness to the cache TTL for the same reason — see
  // the field's comment on `Slot`.
  const etag = computeETag({
    salt: "engagement-v1",
    maxMtimeMs: slot.maxMtime,
    parts: [
      period, project ?? "", home ?? "", timeZone,
      String(config.responseThresholdMs),
      String(config.runCapMs),
      String(config.tailCreditMs),
      String(slot.cachedAt),
    ],
  });

  const notModified = ifNoneMatch(request, etag);
  if (notModified) return notModified;
  return jsonWithETag(slot.report, etag);
}
