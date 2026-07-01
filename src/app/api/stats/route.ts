import { NextRequest } from "next/server";
import { getStatsCacheMtimeMs } from "@/lib/scanner/claudeStats";
import { computeETag, ifNoneMatch, jsonWithETag } from "@/lib/httpCache";
import { getStatsInputs, buildStatsResponse } from "@/lib/server/queries/stats";

// Scan + claude-usage caches and the response assembly live in
// `@/lib/server/queries/stats` so the RSC prefetch (PR 3) produces a
// byte-identical body. The ETag stays here — it needs the cached usage
// watermark the inputs expose.

export async function GET(request: NextRequest) {
  const inputs = await getStatsInputs();

  // ETag inputs:
  //   - `salt` includes the backend label so a runtime swap (DB <-> file)
  //     rotates the ETag and clients re-fetch instead of being 304'd against
  //     bytes that may carry a different `costEstimate`.
  //   - `maxMtimeMs` combines content freshness (`inputs.maxMtime`, fresh under
  //     DB / 0 under file) with scan freshness (`result.scannedAt`).
  // Fold Claude's stats-cache.json mtime in too: a change to it alone alters
  // the cross-check block, and the ETag is checked before the body is built —
  // without this a client could be 304'd onto a stale cross-check.
  const statsCacheMtime = await getStatsCacheMtimeMs();
  const etag = computeETag({
    salt: `stats-v2-${inputs.backend}`,
    maxMtimeMs: Math.max(
      inputs.maxMtime,
      new Date(inputs.result.scannedAt).getTime(),
      statsCacheMtime,
    ),
  });

  const notModified = ifNoneMatch(request, etag);
  if (notModified) return notModified;

  const body = await buildStatsResponse(inputs);
  const response = jsonWithETag(body, etag);
  response.headers.set("X-Minder-Backend", inputs.backend);
  return response;
}
