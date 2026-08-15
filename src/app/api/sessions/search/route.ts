import { NextRequest, NextResponse } from "next/server";
import {
  searchSessions,
  type SessionSearchScope,
  type SessionSearchFacets,
} from "@/lib/data";
import { SessionSearchError } from "@/lib/data/sessionSearch";

// Session search endpoint. Backed by `prompts_fts` (FTS5) for body
// matches and `sessions.{slug,initial_prompt,last_prompt,project_dir_name,
// git_branch}` LIKE for title-class matches. The two paths are merged
// inside `searchSessionsInDb` with JS-side dedup by session_id.
//
// Query params:
//   q      — search text (required, non-empty after trim)
//   scope  — 'titles' | 'prompts' | 'both' (default: 'both')
//   limit  — clamp to 1..200 (default: 50)
//
// Row-level facets (all optional). These are applied IN SQL, inside every
// retriever, so `limit` counts faceted rows (#425). Filtering them
// client-side after the cut silently under-reports: a query matching more
// than `limit` sessions could report zero for a facet whose matches all
// ranked below the cutoff. Omit a facet to leave that axis unconstrained.
//   source      — adapter source id (e.g. 'claude'); rows with no source
//                 count as 'claude', matching the client's `?? "claude"`.
//   entrypoint  — bucketed entrypoint (e.g. 'cli', 'sdk-cli', 'unknown');
//                 null AND empty-string rows both bucket to 'unknown'.
//
//   `source` and `entrypoint` accept ANY non-empty value — deliberately no
//   allowlist. Both are open sets that grow when an adapter or entrypoint
//   is added, so validating against a fixed list would reject a legitimate
//   new value, and an unrecognized one already yields an empty result that
//   is *true* rather than misleading. Only emptiness is rejected. `starred`
//   is different because it is a closed two-value axis, so an unrecognized
//   value there IS meaningful and gets a 400.
//   starred     — '1' / 'true' to restrict to starred sessions. Any other
//                 value is rejected rather than coerced, because silently
//                 reading an unrecognized value as "unfiltered" would
//                 answer a different question than the one asked.
//
// Response shape:
//   { hits: SessionSearchHit[], backend: 'db' | 'file' }
//
// `SessionSearchHit` (src/lib/data/sessionSearch.ts) is the authority —
// it carries `ranks` and an optional `snippet` beyond the
// `{sessionId, score, source}` this comment used to list, and naming the
// type keeps the two from drifting again as fields are added.
//
// Notes:
//   - `backend: 'file'` means MINDER_USE_DB=0 — the SessionsBrowser
//     should fall back to client-side filtering of cached
//     `searchableText`. Distinct from `hits: []` under `backend: 'db'`
//     (which means "DB has no matches").
//   - 400 on empty `q` after trim (the caller should keep a debounced
//     input that holds back the request until the user stops typing).
//   - 400 on FTS5 parse error — surfaced as a `SessionSearchError`
//     from the loader; the route mappings keep the error shape
//     grep-able. Internal DB unavailability becomes 500 via the
//     façade's `DbUnavailableError` path.

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MIN_QUERY_CHARS = 2;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const q = (params.get("q") ?? "").trim();
  const scopeRaw = params.get("scope") ?? "both";
  const limitRaw = params.get("limit");

  if (q.length < MIN_QUERY_CHARS) {
    return NextResponse.json(
      { error: `q must be at least ${MIN_QUERY_CHARS} characters after trim` },
      { status: 400 }
    );
  }

  if (scopeRaw !== "titles" && scopeRaw !== "prompts" && scopeRaw !== "both") {
    return NextResponse.json(
      { error: `scope must be 'titles' | 'prompts' | 'both' (got: ${scopeRaw})` },
      { status: 400 }
    );
  }
  const scope: SessionSearchScope = scopeRaw;

  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const parsed = parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return NextResponse.json(
        { error: `limit must be a positive integer (got: ${limitRaw})` },
        { status: 400 }
      );
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  // Facets. `null` (absent) leaves the axis unconstrained; an empty
  // string is rejected rather than treated as absent, since `?source=`
  // more likely means a client built the URL wrong than that it wanted
  // every source — and the wrong reading is silent.
  const facets: SessionSearchFacets = {};
  for (const key of ["source", "entrypoint"] as const) {
    const raw = params.get(key);
    if (raw === null) continue;
    // Validate and store the SAME value. Checking `raw.trim()` for
    // emptiness but filtering on `raw` would let `?source=claude%20`
    // through validation and then match nothing — a silent empty result
    // from a well-formed-looking request, which is the exact failure
    // class this endpoint's facets exist to remove.
    const value = raw.trim();
    if (value === "") {
      return NextResponse.json(
        { error: `${key} must be non-empty when present (omit it to leave unfiltered)` },
        { status: 400 }
      );
    }
    facets[key] = value;
  }

  const starredRaw = params.get("starred");
  if (starredRaw !== null) {
    // Deliberately not `Boolean(starredRaw)` — that reads "0" and
    // "false" as true, which is the inverse of what the caller asked
    // for and produces a confidently wrong result set.
    if (starredRaw !== "1" && starredRaw !== "true") {
      return NextResponse.json(
        { error: `starred must be '1' or 'true' when present (got: ${starredRaw})` },
        { status: 400 }
      );
    }
    facets.starredOnly = true;
  }

  try {
    const { hits, meta } = await searchSessions(q, scope, limit, facets);
    return NextResponse.json(
      { hits, backend: meta.backend },
      { headers: { "X-Minder-Backend": meta.backend } }
    );
  } catch (err) {
    if (err instanceof SessionSearchError && err.reason === "fts-parse") {
      return NextResponse.json(
        { error: "FTS5 rejected the query — try simpler terms", detail: err.message },
        { status: 400 }
      );
    }
    throw err;
  }
}
