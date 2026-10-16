import type { SessionSummary } from "@/lib/types";
import { entrypointBucket } from "@/lib/usage/entrypoint";
import type { SessionSearchFacets, SessionSearchHit, SessionSearchScope } from "./sessionSearch";

// Session search without the index: a substring scan over session summaries.
// Serves `searchSessions` when there is no FTS index to ask (`MINDER_USE_DB=0`,
// demo mode). The Sessions page used to do this scan itself over a
// `searchableText` copy shipped in every list response, 13 MB of a 34 MB
// list (#700); the scan moved here so the list no longer carries it.
//
// The `titles` fields mirror the SQL `titles` retriever in `sessionSearch.ts`.

/**
 * The summaries without `searchableText`, for anything that sends a list out of
 * the server. Only the scan below reads that text; it was 13 MB of a 34 MB
 * `/api/sessions` response (#700). The index never fills it, so on that path
 * the input comes back as is; the file parse and demo fixtures do fill it.
 */
export function withoutSearchableText(sessions: SessionSummary[]): SessionSummary[] {
  if (!sessions.some((s) => s.searchableText !== undefined)) return sessions;
  return sessions.map(({ searchableText: _text, ...rest }) => rest);
}

/** Characters of context kept either side of the match in a hit's snippet. */
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 120;

function titleFields(s: SessionSummary): Array<string | undefined> {
  return [
    s.slug,
    s.initialPrompt,
    s.lastPrompt,
    s.projectName,
    s.gitBranch,
    s.generatedTitle,
    s.aiTitle,
  ];
}

function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(text.length, at + length + SNIPPET_AFTER);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function matchesFacets(s: SessionSummary, facets: SessionSearchFacets | undefined): boolean {
  if (!facets) return true;
  if (facets.source !== undefined && (s.source ?? "claude") !== facets.source) return false;
  if (facets.entrypoint !== undefined && entrypointBucket(s.entrypoint) !== facets.entrypoint) {
    return false;
  }
  if (facets.starredOnly && !s.starredAt) return false;
  return true;
}

const recency = (s: SessionSummary): number => {
  const ms = new Date(s.endTime ?? s.startTime ?? 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * Sessions whose title fields or text contain `query` (case-insensitive), most
 * recent first. Facets apply before `limit`, as in the SQL path (#425). Content
 * hits carry a snippet of the matched text, since the browser no longer has it.
 */
export function searchSessionSummaries(
  sessions: SessionSummary[],
  query: string,
  scope: SessionSearchScope = "both",
  limit = 50,
  facets?: SessionSearchFacets
): SessionSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matched: Array<{ s: SessionSummary; snippet?: string }> = [];
  for (const s of sessions) {
    if (!matchesFacets(s, facets)) continue;
    if (scope !== "prompts" && titleFields(s).some((f) => f?.toLowerCase().includes(needle))) {
      matched.push({ s });
      continue;
    }
    if (scope === "titles" || !s.searchableText) continue;
    const at = s.searchableText.toLowerCase().indexOf(needle);
    if (at !== -1) matched.push({ s, snippet: snippetAround(s.searchableText, at, needle.length) });
  }

  matched.sort((a, b) => recency(b.s) - recency(a.s));
  return matched.slice(0, limit).map(({ s, snippet }, i) => {
    const source = snippet === undefined ? "titles" : "prompts";
    return {
      sessionId: s.sessionId,
      // Rank-shaped like the RRF scores: only the order means anything.
      score: 1 / (i + 1),
      source,
      ranks: { [source]: i + 1 },
      ...(snippet !== undefined ? { snippet } : {}),
    };
  });
}
