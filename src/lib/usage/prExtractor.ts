/**
 * PR extractor — finds `gh pr create` Bash invocations in a session and
 * matches them by `tool_use_id` to the next user `tool_result` block,
 * harvesting any GitHub PR URL the result text exposes. Pure /
 * data-in-data-out so the same extractor wires into both the file-parse
 * scanner (`claudeConversations.scanSessionFile`) and the DB ingest
 * pipeline (`db/ingest.writeSession`).
 *
 * Matching by `tool_use_id` (not by positional ordering) is load-bearing:
 * Claude routinely runs Bash in parallel with other tool calls, and the
 * results stream back in arbitrary order. Positional matching would
 * silently associate a `gh pr create` with the wrong result if any other
 * tool ran alongside it.
 */

import type { ConversationEntry } from "../scanner/claudeConversations";
import type { PrLink } from "../types";

export type { PrLink };

// `gh pr create` accepts a long flag list (`--title`, `--body`, etc.) and is
// often piped through `bash -c`. We require the literal substring AND that it
// appears at a command boundary (start, after `&&`/`||`/`;`/`|`, or newline) —
// the previous unanchored substring match misattributed commands like
// `grep "gh pr create" docs/` or `echo "remember to gh pr create"`. Quotes are
// stripped before matching (see `stripQuotedRegions`), so quoted occurrences of
// the literal don't trigger a false positive.
const GH_PR_CREATE_RE = /(?:^|[\n;]|&&|\|\|)\s*gh\s+pr\s+create\b/;

// GitHub PR URLs follow `https://github.com/<owner>/<repo>/pull/<N>`. Owner and
// repo names allow letters, digits, dot, hyphen, underscore — no slashes.
// Anchor on `/pull/` (so `/issues/`, `/discussions/`, `/commit/` etc. don't
// match) and require a word boundary after the PR number so `pull/42xyz`
// doesn't extract `42`. (`\b` between a digit and a letter is NOT a
// boundary — both are word chars — so requiring it after `\d+` rejects
// `42xyz` while still accepting trailing `/`, `#`, `?`, or end-of-string.)
const PR_URL_RE = /https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)\b/;
// Global form used by `extractPrLinkFromText` to enumerate every URL in a
// result body so the "URL on its own line" preference wins over the first
// match. Kept separate from `PR_URL_RE` so the non-global version stays
// usable for the single-match callers.
const PR_URL_RE_G = new RegExp(PR_URL_RE.source, "g");

// `\b` after `\d+` requires a digit-to-non-word transition. With trailing
// digits gone, the next char is either whitespace/`/`/`#`/`?` or end-of-string —
// all valid word boundaries.

interface ToolUseObservation {
  id: string;
  command: string;
}

/**
 * Strip single- and double-quoted regions from a shell command so a literal
 * `gh pr create` inside a quoted argument (e.g. `grep "gh pr create" docs/`)
 * doesn't trigger a false positive. Naive — no shell parser — but good
 * enough for the discriminator: when the command's real `gh pr create` is
 * at a statement boundary, removing quoted regions leaves it intact. The
 * one mode this misses is `bash -c 'gh pr create'`, where the real
 * invocation is inside the quote; we accept this gap because Claude Code's
 * Bash tool passes commands directly to the shell, not via `bash -c`.
 */
function stripQuotedRegions(s: string): string {
  return s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "");
}

/**
 * Owner/repo names must contain at least one alphanumeric. Defends against
 * malformed URL fragments like `https://github.com/./../pull/5` where the
 * raw character class `[A-Za-z0-9._-]+` would accept `.` and `..` as full
 * segments. gh CLI won't emit these in success paths, but tool_result text
 * isn't sanitized.
 */
function hasAlnum(s: string): boolean {
  return /[A-Za-z0-9]/.test(s);
}

/**
 * Extract the text payload from a `tool_result` block's `content` field.
 * The MCP/Anthropic spec allows either a bare string or an array of
 * `{type:"text", text:string}` blocks; both paths feed back here through
 * the same scan loops in claudeConversations.ts and ingest.ts.
 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let acc = "";
  for (const c of content) {
    if (c && typeof c === "object" && (c as { type?: unknown }).type === "text") {
      const text = (c as { text?: unknown }).text;
      if (typeof text === "string") acc += text;
    }
  }
  return acc;
}

/**
 * Walk a session's `ConversationEntry[]` once and yield every PR link the
 * session produced, from two sources:
 *
 *   1. **`type: "pr-link"` entries (A1)** — Claude Code records these itself.
 *      Authoritative: they survive truncated command output and catch PRs
 *      opened by any route (the web UI, `gh pr create --web`, a script), not
 *      just ones whose `gh` output was scrapeable.
 *   2. **`gh pr create` tool results** — the original scraper.
 *
 * **Both sources are permanent.** A5 was specified expecting the scraper to be
 * retired once `pr-link` entries covered the corpus. Measured across 5,319 local
 * transcripts, that is wrong: the recorded entries find 738 distinct PR URLs to
 * the scraper's 657 — 86 that the regex never sees — but **5 URLs are found only
 * by the scraper**, and every one of those came from a session that *did* emit
 * `pr-link` entries for its other PRs. So the gap is not "old transcripts
 * predate the feature", which would age out on its own; it is the CLI's own
 * recording missing cases. Dropping the scraper would lose real links today and
 * keep losing them.
 *
 * The decode lives HERE rather than in either reader so both backends get it
 * from one place. Putting it in the file scanner alone left the default DB
 * path — which persists PRs through this function — reading only scraped
 * results, so an authoritatively-recorded PR never reached `session_prs`
 * (Codex review, PR #377).
 *
 * On a URL collision the `pr-link` entry wins: its `prRepository` is reported
 * by Claude Code, whereas the scraper's `repo` is parsed back out of the URL.
 *
 * Multiple PRs per session are returned sorted by PR number ascending —
 * matches the DB read-side `ORDER BY session_id, pr_number` so chip order is
 * stable across both backends.
 */
export function extractPrsFromEntries(entries: ConversationEntry[]): PrLink[] {
  const bashPrCalls: ToolUseObservation[] = [];
  const resultsByToolUseId = new Map<string, string>();
  const prLinkEntries: PrLink[] = [];

  for (const entry of entries) {
    // A1: Claude Code's own record of a PR. Requires both a URL and a numeric
    // number — a partial entry is not a usable link, and coercing a missing
    // number to 0 would render as `PR #0`.
    if (entry.type === "pr-link") {
      const { prUrl, prNumber, prRepository } = entry;
      if (typeof prUrl === "string" && prUrl && typeof prNumber === "number") {
        prLinkEntries.push({
          url: prUrl,
          number: prNumber,
          repo: typeof prRepository === "string" ? prRepository : "",
          source: "recorded",
        });
      }
      continue;
    }

    if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content as Array<Record<string, unknown>>) {
        if (
          block.type === "tool_use" &&
          block.name === "Bash" &&
          typeof block.id === "string" &&
          block.input &&
          typeof (block.input as { command?: unknown }).command === "string"
        ) {
          const command = (block.input as { command: string }).command;
          if (GH_PR_CREATE_RE.test(stripQuotedRegions(command))) {
            bashPrCalls.push({ id: block.id, command });
          }
        }
      }
      continue;
    }

    if (entry.type === "user") {
      const content =
        (entry.message?.content as unknown) ??
        (entry as { content?: unknown }).content ??
        [];
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type !== "tool_result") continue;
        const toolUseId = block.tool_use_id;
        if (typeof toolUseId !== "string") continue;
        const text = toolResultText(block.content);
        if (!text) continue;
        // Concatenate when a tool_use_id surfaces in multiple result
        // blocks (rare, but possible on retries) — the URL match looks
        // at the whole thing.
        const prior = resultsByToolUseId.get(toolUseId);
        resultsByToolUseId.set(toolUseId, prior ? prior + text : text);
      }
    }
  }

  const links: PrLink[] = [];
  const seenUrls = new Set<string>();

  for (const call of bashPrCalls) {
    const resultText = resultsByToolUseId.get(call.id);
    if (!resultText) continue;
    const link = extractPrLinkFromText(resultText);
    if (!link) continue;
    if (seenUrls.has(link.url)) continue;
    seenUrls.add(link.url);
    links.push({ ...link, source: "scraped" });
  }

  // Authoritative `pr-link` entries, folded in after the scraper so a recorded
  // link REPLACES a scraped one for the same URL (better `repo`) rather than
  // being dropped as a duplicate.
  for (const entry of prLinkEntries) {
    const existing = links.findIndex((l) => l.url === entry.url);
    if (existing >= 0) {
      // Keep the scraper's repo only if the entry didn't report one. The row
      // becomes `recorded`, which is the honest label: every field on it now
      // comes from Claude Code unless the fallback below supplied `repo`.
      links[existing] = { ...entry, repo: entry.repo || links[existing].repo };
    } else if (!seenUrls.has(entry.url)) {
      seenUrls.add(entry.url);
      links.push(entry);
    }
  }
  // Sort by PR number ascending so DB-backed and file-parse backends agree
  // on chip order. The DB read path uses `ORDER BY session_id, pr_number`.
  links.sort((a, b) => a.number - b.number);
  return links;
}

/**
 * Parse a GitHub PR URL out of a tool-result body.
 *
 * Selection rule: `gh pr create`'s canonical output puts the new PR URL on
 * its own line, typically as the first or only line. When the result text
 * contains multiple PR URLs (e.g., the user's `--body` argument was echoed
 * and references prior PRs), the URL on a line by itself wins over an
 * embedded reference. Falls back to the first URL when no line-isolated
 * URL exists.
 *
 * Validation: owner and repo names must contain at least one alphanumeric
 * character. Filters out malformed inputs like `https://github.com/./../pull/5`.
 *
 * Exposed so tests can hammer the regex against weird inputs (trailing
 * slashes, anchors, query strings, repos with dots) without staging a
 * fake conversation log.
 */
export function extractPrLinkFromText(text: string): PrLink | null {
  const candidates: Array<{ match: RegExpExecArray; atLineStart: boolean }> = [];
  PR_URL_RE_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PR_URL_RE_G.exec(text)) !== null) {
    const atLineStart = m.index === 0 || text[m.index - 1] === "\n";
    candidates.push({ match: m, atLineStart });
  }
  if (candidates.length === 0) return null;

  // Prefer the first URL that appears at the start of a line (matches gh
  // CLI's actual output shape: the new URL on its own line). Falls back
  // to the first match if no line-start URL exists.
  const preferred = candidates.find((c) => c.atLineStart) ?? candidates[0];
  const [, owner, repo, num] = preferred.match;
  if (!hasAlnum(owner) || !hasAlnum(repo)) return null;
  const number = Number(num);
  if (!Number.isFinite(number) || number <= 0) return null;
  return {
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    number,
    repo: `${owner}/${repo}`,
  };
}
