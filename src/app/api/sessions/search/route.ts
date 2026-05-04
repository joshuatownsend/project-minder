import { NextRequest, NextResponse } from "next/server";
import { searchSessions, type SessionSearchScope } from "@/lib/data";
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
// Response shape:
//   { hits: Array<{ sessionId, score, source }>, backend: 'db' | 'file' }
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

  try {
    const { hits, meta } = await searchSessions(q, scope, limit);
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
