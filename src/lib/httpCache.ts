import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

// Tiny ETag/Cache-Control helper for routes that derive their payload from
// mtime-keyed file caches. The pattern:
//   1. Build an ETag from the inputs that determine the response (max input
//      mtime + query params + a route-specific salt).
//   2. If the request's `If-None-Match` matches, return 304 with no body.
//   3. Otherwise let the route compute the response and stamp it with the
//      same ETag + a Cache-Control header.
//
// `stale-while-revalidate=60` lets the browser show last-known-good for up
// to 60 s while a background revalidation request fetches the new ETag.
// During SWR the route still runs, but the response usually short-circuits
// to 304 so the cost is dominated by stat() not parse().

const DEFAULT_CACHE_CONTROL = "private, max-age=0, stale-while-revalidate=60";

export interface ETagInputs {
  /** Largest mtime (ms since epoch) across the files this route consumes. */
  maxMtimeMs: number;
  /**
   * Anything else that should cause the ETag to differ — query params, route
   * variant, schema version. Stringified order doesn't matter as long as the
   * same inputs always produce the same string.
   */
  parts?: Array<string | number | undefined>;
  /** Route-specific salt so two routes with identical inputs don't collide. */
  salt: string;
}

export function computeETag(inputs: ETagInputs): string {
  const parts = (inputs.parts ?? []).map((p) => p ?? "").join("|");
  const raw = `${inputs.salt}|${inputs.maxMtimeMs}|${parts}`;
  // sha1 is fine here — this is a cache-bust key, not a security boundary.
  // Quoted form per RFC 7232 §2.3.
  const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
  return `"${hash}"`;
}

/** Returns a 304 response if the request's If-None-Match matches `etag`. */
export function ifNoneMatch(request: NextRequest, etag: string): NextResponse | null {
  const header = request.headers.get("if-none-match");
  if (!header) return null;
  // Allow `If-None-Match: *` (always match) and exact comma-separated lists.
  if (header === "*" || header.split(",").some((v) => v.trim() === etag)) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": DEFAULT_CACHE_CONTROL,
      },
    });
  }
  return null;
}

/**
 * Stamp a JSON response with ETag + Cache-Control. Use this instead of
 * `NextResponse.json(body)` so every response from a cached route has the
 * same surface for browsers and intermediate caches.
 */
export function jsonWithETag(
  body: unknown,
  etag: string,
  cacheControl: string = DEFAULT_CACHE_CONTROL
): NextResponse {
  const res = NextResponse.json(body);
  res.headers.set("ETag", etag);
  res.headers.set("Cache-Control", cacheControl);
  return res;
}

/**
 * Plain Cache-Control without ETag. Use for routes that don't yet have a
 * reliable change signal (e.g. catalog routes that depend on multiple file
 * sources we haven't mtime-cached yet) but still want browsers to dedupe
 * back-to-back navigations. `max-age=120` matches the existing in-process
 * 2-min TTLs those routes already use, so it doesn't change observable
 * staleness — it just lets the client also remember.
 */
export function jsonWithCacheControl(
  body: unknown,
  cacheControl: string = "private, max-age=120"
): NextResponse {
  const res = NextResponse.json(body);
  res.headers.set("Cache-Control", cacheControl);
  return res;
}
