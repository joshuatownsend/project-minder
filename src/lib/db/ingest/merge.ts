// PR/ticket link extraction + merge helpers extracted verbatim from
// `ingest.ts`. Pure and module-state-free: the fail-soft extractors guard the
// PR and ticket harvesters independently, and the merge helpers union a fresh
// extraction with the preserved rows, keeping ordering aligned with the SQL
// read side so the file-parse and DB backends stay identical. Behavior is
// unchanged from the previous in-file form.

import type { PrLink, TicketLink } from "@/lib/types";
import type { ConversationEntry } from "@/lib/scanner/claudeConversations";
import { extractPrsFromEntries } from "@/lib/usage/prExtractor";
import { extractTicketsFromEntries, compareTicketLinks } from "@/lib/usage/ticketExtractor";

// Both extractors take the SAME `ConversationEntry[]`, so the caller
// builds it once (see `readJsonlSession`) and passes it to both — one
// walk of `parsedLines`, not two. Each call stays independently guarded:
// a throw in PR extraction must still let tickets index, and vice versa.
export function safeExtractPrs(entries: ConversationEntry[], sessionId: string): PrLink[] {
  try {
    return extractPrsFromEntries(entries);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[ingest] PR extraction failed for ${sessionId}:`, err);
    return [];
  }
}

export function safeExtractTickets(entries: ConversationEntry[], sessionId: string): TicketLink[] {
  try {
    return extractTicketsFromEntries(entries);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[ingest] ticket extraction failed for ${sessionId}:`, err);
    return [];
  }
}

/**
 * Union two PR-link lists, deduping by URL. `current` (fresh extraction)
 * wins on overlap so a re-extract that corrects metadata (e.g., the
 * canonical URL form) supersedes the preserved row. Order matches
 * `extractPrsFromEntries`'s post-sort (pr_number ascending), so the
 * merged output and the SQL `ORDER BY session_id, pr_number` read
 * stay aligned across backends. Read review #2 and #7.
 */
export function mergePrLinks(current: PrLink[], preserved: PrLink[]): PrLink[] {
  const byUrl = new Map<string, PrLink>();
  for (const pr of preserved) byUrl.set(pr.url, pr);
  for (const pr of current) byUrl.set(pr.url, pr); // current overrides
  return Array.from(byUrl.values()).sort((a, b) => a.number - b.number);
}

/**
 * Union two ticket-link lists, deduping by URL — the ticket analogue of
 * `mergePrLinks`. `current` (fresh extraction) wins on overlap. Sorted by
 * (provider, key, url) to match `extractTicketsFromText`'s post-sort and
 * the SQL read's `ORDER BY provider, ticket_key, url`, so chip order stays
 * aligned across the file-parse and DB backends.
 */
export function mergeTicketLinks(current: TicketLink[], preserved: TicketLink[]): TicketLink[] {
  const byUrl = new Map<string, TicketLink>();
  for (const t of preserved) byUrl.set(t.url, t);
  for (const t of current) byUrl.set(t.url, t); // current overrides
  return Array.from(byUrl.values()).sort(compareTicketLinks);
}
