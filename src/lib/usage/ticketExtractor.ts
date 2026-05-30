/**
 * Ticket extractor — finds issue-tracker references in a session by
 * scanning every text block (user prompts, assistant text, and Bash/tool
 * `tool_result` output) for a *full* tracker URL and deduping by URL.
 *
 * Why an all-text scan rather than the call→result pairing that
 * `prExtractor` does: a `gh pr create` URL is only meaningful as the
 * OUTPUT of the create command, so that extractor matches a Bash call to
 * its result by `tool_use_id`. A ticket reference is meaningful WHEREVER
 * it appears — a prompt, an assistant explanation, or a `gh issue create`
 * result all count — so we just regex the concatenated text. This is both
 * simpler (no `tool_use_id` matching, no tail-straddle recovery) and
 * higher-recall (a `gh issue create` URL lands in a tool_result text
 * block and is picked up for free).
 *
 * Scope (item 3, PR #1): FULL URLs only — Linear `…/issue/KEY`, Jira
 * `…/browse/KEY`, and GitHub `…/issues/N`. A full URL is self-validating:
 * provider, key, and canonical link all derive from the URL itself, so
 * scanning prompts is safe (≈ zero false positives). Bare keys
 * (`ABC-123`, bare `#N`) from branch names / commit messages are the
 * false-positive-prone case and need per-workspace config to build a URL;
 * they are deliberately deferred to a follow-up.
 *
 * Pure / data-in-data-out so the same extractor wires into both the
 * file-parse scanner and the DB ingest pipeline, exactly like
 * `prExtractor`.
 */

import type { ConversationEntry } from "../scanner/claudeConversations";
import { extractText, extractToolResults } from "./contentBlocks";
import type { TicketLink } from "../types";

// An issue KEY is an uppercase project prefix + number, e.g. `ENG-123`,
// `PROJ-45`. Both Linear and Jira use this shape; the URL host
// disambiguates the provider. Requiring a leading letter and the `-\d+`
// suffix keeps it from matching things like `UTF-8` (no leading letter on
// the digit side is fine, but `UTF-8` → prefix `UTF`, num `8` *would*
// match a bare key — which is exactly why bare-key scanning is deferred;
// here the key only counts when wrapped in a tracker URL path).
const ISSUE_KEY = "[A-Z][A-Z0-9]*-\\d+";

// Linear: https://linear.app/<workspace>/issue/<KEY>[/<slug>] — capture
// workspace + key, drop any trailing slug/anchor (canonicalized below).
const LINEAR_URL_RE = new RegExp(
  `https?://linear\\.app/([A-Za-z0-9._-]+)/issue/(${ISSUE_KEY})\\b`,
  "g"
);

// Jira: https://<host>/browse/<KEY> — the shareable issue link. `host`
// must look like a real hostname (at least one dot) so a stray
// `/browse/AB-1` path on some unrelated single-label host doesn't match.
const JIRA_URL_RE = new RegExp(
  `https?://([A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+)/browse/(${ISSUE_KEY})\\b`,
  "g"
);

// GitHub issues: mirror prExtractor's PR_URL_RE with `/issues/` for
// `/pull/`. Word boundary after the number rejects `issues/42x`.
const GH_ISSUE_URL_RE =
  /https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)\b/g;

/** Owner/repo segments must contain at least one alphanumeric. Mirrors
 *  prExtractor's `hasAlnum` guard against `…/./../issues/5`. */
function hasAlnum(s: string): boolean {
  return /[A-Za-z0-9]/.test(s);
}

/**
 * Concatenate every human/assistant/tool text surface in a session into
 * one blob for URL scanning, reusing the shared content-block walkers in
 * `contentBlocks` (the one home for that walk, so the parse paths can't
 * drift). We intentionally skip `tool_use` *inputs* (command strings): a
 * tracker URL pasted into a `gh issue create --body` is rare, and the
 * created issue's URL comes back in the tool_result we already scan.
 * Keeping the surface to prompts + assistant text + results is the
 * low-false-positive set the scope calls for.
 */
function collectText(entries: ConversationEntry[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.type === "assistant") {
      parts.push(extractText(entry.message?.content));
      continue;
    }
    if (entry.type === "user") {
      // Plain prompts put a bare string on `message.content`; tool-result /
      // multi-part turns use an array of blocks that may live on
      // `message.content` OR — when that array is EMPTY — on top-level
      // `content`. Mirror `parser.ts`'s length-based fallback (not a
      // nullish one): an empty `message.content` must not hide a top-level
      // tool_result, or its ticket URL is silently dropped. (See project
      // memory on the mixed string-vs-array user-content shape.)
      const msg = (entry.message?.content as unknown) ?? [];
      if (typeof msg === "string") {
        parts.push(msg);
        continue;
      }
      const source =
        Array.isArray(msg) && msg.length === 0
          ? ((entry as { content?: unknown }).content ?? msg)
          : msg;
      if (typeof source === "string") {
        parts.push(source);
      } else {
        parts.push(extractText(source), extractToolResults(source));
      }
    }
  }
  return parts.filter(Boolean).join("\n");
}

/**
 * Comparator for the canonical `(provider, key, url)` ticket ordering,
 * shared by the extractor's post-sort and ingest's `mergeTicketLinks` so
 * both stay aligned with the SQL `ORDER BY provider, ticket_key, url` —
 * chip order is then identical across file-parse and DB backends.
 */
export function compareTicketLinks(a: TicketLink, b: TicketLink): number {
  return (
    a.provider.localeCompare(b.provider) ||
    a.key.localeCompare(b.key) ||
    a.url.localeCompare(b.url)
  );
}

/**
 * Parse every full tracker URL out of a text blob. Exposed so tests can
 * hammer the regexes against odd inputs (trailing slugs, anchors, query
 * strings) without staging a fake conversation log. Deduped by canonical
 * URL; sorted by (provider, key, url).
 */
export function extractTicketsFromText(text: string): TicketLink[] {
  const byUrl = new Map<string, TicketLink>();

  const add = (link: TicketLink) => {
    if (!byUrl.has(link.url)) byUrl.set(link.url, link);
  };

  let m: RegExpExecArray | null;

  LINEAR_URL_RE.lastIndex = 0;
  while ((m = LINEAR_URL_RE.exec(text)) !== null) {
    const [, workspace, key] = m;
    if (!hasAlnum(workspace)) continue;
    add({ provider: "linear", key, url: `https://linear.app/${workspace}/issue/${key}` });
  }

  JIRA_URL_RE.lastIndex = 0;
  while ((m = JIRA_URL_RE.exec(text)) !== null) {
    const [, host, key] = m;
    add({ provider: "jira", key, url: `https://${host}/browse/${key}` });
  }

  GH_ISSUE_URL_RE.lastIndex = 0;
  while ((m = GH_ISSUE_URL_RE.exec(text)) !== null) {
    const [, owner, repo, num] = m;
    if (!hasAlnum(owner) || !hasAlnum(repo)) continue;
    const number = Number(num);
    if (!Number.isFinite(number) || number <= 0) continue;
    add({
      provider: "github",
      key: `${owner}/${repo}#${number}`,
      url: `https://github.com/${owner}/${repo}/issues/${number}`,
    });
  }

  return [...byUrl.values()].sort(compareTicketLinks);
}

/**
 * Walk a session's `ConversationEntry[]` and return every ticket URL it
 * references, deduped and sorted. Counterpart to
 * `extractPrsFromEntries`.
 */
export function extractTicketsFromEntries(entries: ConversationEntry[]): TicketLink[] {
  return extractTicketsFromText(collectText(entries));
}
