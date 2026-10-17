import type { SessionSummary } from "@/lib/types";
import { truncate } from "@/lib/utils";

// What the session list sends out of the server (`/api/sessions`, MCP), as
// opposed to what the no-index search scans, which keeps everything.

/**
 * Characters of `initialPrompt` and `lastPrompt` the list keeps (#704). The
 * list shows them on one line; the session detail and the server's title
 * search read the stored prompt. Matches the cut the transcript parse already
 * makes for Claude sessions (`extractHumanText`).
 */
export const LIST_PROMPT_CHARS = 200;

/** `text` clipped to {@link LIST_PROMPT_CHARS}, with "…" marking a cut. */
export const clipListPrompt = <T extends string | null | undefined>(text: T): T =>
  (text && truncate(text, LIST_PROMPT_CHARS)) as T;

/**
 * The summaries as the list sends them: without `searchableText`, which only
 * the no-index search reads (#700), and with the prompts clipped (#704).
 * Never changes the caller's objects.
 */
export function forSessionsList(sessions: SessionSummary[]): SessionSummary[] {
  return sessions.map(({ searchableText: _text, ...rest }) => {
    if (rest.initialPrompt) rest.initialPrompt = clipListPrompt(rest.initialPrompt);
    if (rest.lastPrompt) rest.lastPrompt = clipListPrompt(rest.lastPrompt);
    return rest;
  });
}
