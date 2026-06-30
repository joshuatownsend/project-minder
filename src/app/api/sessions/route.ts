import { NextRequest } from "next/server";
import { computeETag, ifNoneMatch, jsonWithETag } from "@/lib/httpCache";
import {
  getSessionsCacheSlot,
  filterSessions,
  getEnabledAdapters,
} from "@/lib/server/queries/sessions";

// Cache slot + filter live in `@/lib/server/queries/sessions` so the RSC
// prefetch (PR 3) shares the exact same cache and filter chain — see that
// module for the parity rationale.

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get("project");
  const source = request.nextUrl.searchParams.get("source");
  // T2.2: optional PR-URL filter. Accept either a full URL
  // (`https://github.com/foo/bar/pull/42`) or just `<owner>/<repo>#<N>` /
  // `#<N>` shorthand — the equality check below covers the full-URL case;
  // shorthand callers should query the full URL we surface in `prs[].url`.
  const prFilter = request.nextUrl.searchParams.get("pr");
  // item3: optional ticket-URL filter, same exact-URL contract as `pr`.
  // The chip stitches the full canonical URL we surface in `tickets[].url`.
  const ticketFilter = request.nextUrl.searchParams.get("ticket");

  // Refresh the in-route cache when stale. The façade itself layers DB and
  // file-parse caches under it, so a refresh that finds no JSONL changes is
  // already cheap — we just don't want to re-do the per-call assembly work
  // (sessions list assembly + serialization) on every dashboard poll.
  const cache = await getSessionsCacheSlot();

  // ETag inputs include both `cachedAt` and `maxSessionMs` deliberately. There
  // are two failure modes to dodge here:
  //   - Rotate-too-often (ETag = cachedAt only): clients lose 304s every 30 s
  //     even when nothing actually changed.
  //   - Rotate-too-rarely (ETag = maxSessionMs only): SessionSummary contains
  //     time-dependent fields (`isActive`, `status`) that the loader
  //     recomputes on every refresh based on the current clock. Two sessions
  //     could "go inactive" across cache rebuilds without any JSONL editing,
  //     and a content-only ETag would 304 conditional clients into displaying
  //     stale activity badges indefinitely.
  // Combining both means the ETag is stable WITHIN a 30 s window (304s work
  // for back-to-back navigations) but rotates ACROSS windows so any
  // time-driven status flip surfaces on the next refresh.
  const enabledAdapters = await getEnabledAdapters();

  const etag = computeETag({
    salt: "sessions-v1",
    maxMtimeMs: Math.max(cache.maxSessionMs, cache.cachedAt),
    parts: [project ?? "", source ?? "", prFilter ?? "", ticketFilter ?? "", cache.result.sessions.length, [...enabledAdapters].sort().join(",")],
  });

  const notModified = ifNoneMatch(request, etag);
  if (notModified) return notModified;

  const results = filterSessions(cache.result.sessions, {
    enabledAdapters,
    project,
    source,
    pr: prFilter,
    ticket: ticketFilter,
  });

  // jsonWithETag returns a NextResponse; layer the backend header on top so
  // soak monitoring / curl checks can verify which path served the request.
  const response = jsonWithETag(results, etag);
  response.headers.set("X-Minder-Backend", cache.result.meta.backend);
  return response;
}
