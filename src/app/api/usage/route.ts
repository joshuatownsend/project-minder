import { NextRequest } from "next/server";
import { validatePeriod } from "@/lib/usage/constants";
import { getUsage, dbModeRequested } from "@/lib/data";
import { computeETag, ifNoneMatch, jsonWithETag } from "@/lib/httpCache";
import type { UsageReport } from "@/lib/usage/types";
import { getOrCreateRouteCache } from "@/lib/routeCache";
import { demoMode } from "@/lib/demo/demoMode";
import { readConfig } from "@/lib/config";
import { normalizePathKey } from "@/lib/platform";

const CACHE_TTL = 2 * 60_000;

interface UsageCacheSlot {
  report: UsageReport;
  cachedAt: number;
  // Snapshot of the input-mtime signal at report-generation time. For the
  // file-parse backend this is `getJsonlMaxMtime()`; for the DB backend it's
  // `MAX(file_mtime_ms) FROM sessions`. Used as the ETag input so the ETag
  // describes the bytes we're about to serve, not the current state — a
  // change inside the cache TTL window would otherwise rotate the ETag while
  // the served bytes stayed identical.
  maxMtime: number;
  backend: "db" | "file";
}

const cache = getOrCreateRouteCache<UsageCacheSlot>("usage", { ttlMs: CACHE_TTL });

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const safePeriod = validatePeriod(params.get("period") || "30d");
  const project = params.get("project") || undefined;
  const source = params.get("source") || undefined;
  // Claude-home discriminator (#311): scopes the report to turns recorded by
  // one configured home (clients pass ProjectData.usageHomeKey verbatim).
  // Re-normalized defensively so a hand-typed `\\wsl$\...` or mixed-case
  // value still matches the normalizePathKey form the stamps use.
  const rawHome = params.get("home") || undefined;
  const home = rawHome ? normalizePathKey(rawHome) : undefined;

  // Include the requested backend in the cache key so a flag flip
  // (MINDER_USE_DB toggled at runtime) invalidates the slot immediately
  // — without this, a cached file-backend report could be served to a
  // db-backend caller for the rest of the 2-min TTL window.
  const requestedBackend = dbModeRequested() ? "db" : "file";
  // Salt the key with demo state too: toggling the in-app `demoMode` flag must
  // invalidate the slot immediately, else the usage page serves real data after
  // enabling (or synthetic after disabling) for the rest of the 2-min TTL.
  const demo = (await demoMode()) ? "demo:" : "";
  // And with the multi-home config: the all-sessions sweep depends on
  // claudeHomes/pathMappings, so a Settings save that adds or removes a home
  // must invalidate immediately, not after the 2-min TTL.
  const cfg = await readConfig();
  const homesSig = JSON.stringify([cfg.claudeHomes ?? [], cfg.pathMappings ?? []]);
  // `home` must be part of the key: two different `?home=` requests within
  // the 2-min TTL would otherwise collide on one slot.
  const cacheKey = `${demo}${requestedBackend}:${safePeriod}:${project || "all"}:${source || "all"}:${home || "all"}:${homesSig}`;
  const cached = cache.get(cacheKey);

  let slot: UsageCacheSlot;
  if (cached) {
    slot = cached;
  } else {
    const { report, meta } = await getUsage(safePeriod, project, source, home);
    slot = {
      report,
      cachedAt: Date.now(),
      maxMtime: meta.maxMtimeMs,
      backend: meta.backend,
    };
    cache.set(cacheKey, slot);
  }

  // Salt the ETag with the backend so a runtime flag flip (e.g. operator
  // toggles MINDER_USE_DB between server starts) invalidates client caches
  // — backends could differ on edge cases until the schema is fully aligned.
  // homesSig rides in `parts` for the same reason it keys the server cache:
  // adding a WSL home whose sessions are all OLDER than local ones doesn't
  // advance maxMtime, and without the signature a conditional request would
  // 304 against the pre-save report.
  const etag = computeETag({
    salt: `usage-v3-${slot.backend}${demo ? "-demo" : ""}`,
    maxMtimeMs: slot.maxMtime,
    // `home` rides in parts like project/source: filtering to a home whose
    // sessions are all older than the rest doesn't advance maxMtime, so
    // without it a conditional request would 304 against the wrong report.
    parts: [safePeriod, project ?? "", source ?? "", home ?? "", homesSig],
  });

  const notModified = ifNoneMatch(request, etag);
  if (notModified) {
    notModified.headers.set("X-Minder-Backend", slot.backend);
    return notModified;
  }

  const response = jsonWithETag(slot.report, etag);
  response.headers.set("X-Minder-Backend", slot.backend);
  return response;
}
