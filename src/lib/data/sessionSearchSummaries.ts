import type { SessionSummary } from "@/lib/types";
import { entrypointBucket } from "@/lib/usage/entrypoint";
import type { SessionSearchFacets, SessionSearchHit, SessionSearchScope } from "./sessionSearch";
import { clipListPrompt } from "./sessionsListPayload";

// Session search without the index: a substring scan over session summaries.
// Serves `searchSessions` when there is no FTS index to ask (`MINDER_USE_DB=0`,
// demo mode). The list sent to the browser carries no session text (#700), so
// this is the only content search on those paths.
//
// The `titles` fields mirror the SQL `titles` retriever in `sessionSearch.ts`.

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

/**
 * A snippet around `needle` (lowercase) in the first prompt containing it, when
 * the list's clipped copy of that prompt cannot show the match (#704). A title
 * hit otherwise reaches the row with no text that contains the query (Codex,
 * Copilot, PR #709). Undefined when the match is within what the list keeps.
 */
export function clippedPromptSnippet(
  prompts: ReadonlyArray<string | null | undefined>,
  needle: string
): string | undefined {
  for (const prompt of prompts) {
    if (!prompt) continue;
    const at = prompt.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    if (clipListPrompt(prompt).toLowerCase().includes(needle)) return undefined;
    return snippetAround(prompt, at, needle.length);
  }
  return undefined;
}

function matchesFacets(s: SessionSummary, facets: SessionSearchFacets | undefined): boolean {
  if (!facets) return true;
  if (facets.source !== undefined && (s.source ?? "claude") !== facets.source) return false;
  if (facets.entrypoint !== undefined && entrypointBucket(s.entrypoint) !== facets.entrypoint) {
    return false;
  }
  if (facets.starredOnly && !s.starredAt) return false;
  if (facets.sources !== undefined && !facets.sources.includes(s.source ?? "claude")) return false;
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

  type Match = { s: SessionSummary; source: "titles" | "prompts"; snippet?: string };
  const matched: Match[] = [];
  for (const s of sessions) {
    if (!matchesFacets(s, facets)) continue;
    if (scope !== "prompts" && titleFields(s).some((f) => f?.toLowerCase().includes(needle))) {
      const snippet = clippedPromptSnippet([s.initialPrompt, s.lastPrompt], needle);
      matched.push({ s, source: "titles", ...(snippet !== undefined ? { snippet } : {}) });
      continue;
    }
    if (scope === "titles" || !s.searchableText) continue;
    const at = s.searchableText.toLowerCase().indexOf(needle);
    if (at !== -1) {
      matched.push({ s, source: "prompts", snippet: snippetAround(s.searchableText, at, needle.length) });
    }
  }

  matched.sort((a, b) => recency(b.s) - recency(a.s));
  return matched.slice(0, limit).map(({ s, source, snippet }, i) => {
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
