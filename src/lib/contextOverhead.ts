import { pluralize } from "@/lib/utils";
import type { HookEntry } from "@/lib/types";
import type { SkillEntry } from "@/lib/indexer/types";

/**
 * Portfolio-wide "context overhead" estimator (TODO #135 / Phase 3).
 *
 * Mounts on `/stats` and answers: "before any of my code is read, how many
 * tokens of context is Claude Code already eating, and where do they go?"
 *
 * Distinct from the per-project `scanner/contextBudget.ts`. That module
 * answers the same question per-project (project CLAUDE.md, project
 * MCP, project skills) with a flat-tokens-per-source model. This one is
 * portfolio-scope (user + plugin + managed + desktop MCP, user + plugin
 * hooks, user CLAUDE.md) and uses a per-tool / per-byte heuristic so the
 * known sum is comparable against *observed* startup tokens — the
 * residual gap surfaces as "unaccounted."
 *
 * Heuristics (Phase 3 plan):
 *   - System prompt baseline:  3,200 tokens (Claude Code's wrapper).
 *   - MCP servers:             ~5 tools/server × 250 tokens/tool ≈ 1,250
 *                              tokens per server. Real tool counts aren't
 *                              available without spawning each server.
 *   - Skills:                  UTF-8 file bytes / 4. Note: Claude Code
 *                              only injects skill *frontmatter* into the
 *                              system prompt — full bodies load on
 *                              invocation. This figure is therefore a
 *                              ceiling (worst case: every skill invoked),
 *                              and the UI labels it as a ceiling.
 *   - Hooks:                   stringified user + plugin hooks JSON,
 *                              bytes / 4. Approximates what Claude Code
 *                              shows the model.
 *   - User CLAUDE.md:          file bytes (with `@imports` expanded) / 4.
 *
 * `BYTES_PER_TOKEN = 4` matches the per-project scanner — close enough for
 * English text + JSON; will under-count Chinese, code-heavy bodies, etc.
 */

export const SYSTEM_PROMPT_BASELINE_TOKENS = 3_200;
export const MCP_TOOLS_PER_SERVER = 5;
export const MCP_TOKENS_PER_TOOL = 250;
export const MCP_TOKENS_PER_SERVER = MCP_TOOLS_PER_SERVER * MCP_TOKENS_PER_TOOL;
export const BYTES_PER_TOKEN = 4;

export type ContextSource =
  | "baseline"
  | "mcp"
  | "skills"
  | "hooks"
  | "memory"
  | "unknown";

export interface SourceRow {
  source: ContextSource;
  label: string;
  tokens: number;
  /** Short sub-label rendered next to the bar (e.g. "12 servers × ~5 tools"). */
  detail: string;
  /** Route to navigate to for "disable" / "manage" — already URL-encoded. */
  actionHref?: string;
  /** Verb-noun label for the action button (e.g. "Manage in /skills"). */
  actionLabel?: string;
}

export interface ContextOverheadInputs {
  mcpServerCount: number;
  /** User + plugin skills. Aggregator sums their `fileBytes` (populated by the indexer
   *  at walk time) and counts them — no fs.stat required. */
  skills: SkillEntry[];
  /** User + plugin hook entries. Aggregator stringifies the array and counts entries. */
  hookEntries: HookEntry[];
  /** UTF-8 bytes of `~/.claude/CLAUDE.md` after `@import` expansion. */
  memoryBytes: number;
  /**
   * Observed `cache_create_tokens` on the first assistant turn for each of
   * the most recent N sessions. Median is taken so a single
   * outlier-large run doesn't skew the comparison. Pass `[]` when no
   * sessions are indexed yet — `observedTokens` will be null.
   */
  observedSamples: number[];
}

export interface ContextOverheadBreakdown {
  /** Theoretical minimum overhead — just the system-prompt baseline. */
  theoreticalMinTokens: number;
  /** Sum of all *known* per-source contributions. */
  knownTokens: number;
  /** Median observed startup tokens, or null when no sessions indexed. */
  observedTokens: number | null;
  /**
   * `max(0, observedTokens - knownTokens)`. Null when observedTokens is
   * null. Negative diffs are clamped — they happen when the heuristics
   * over-count (e.g. inflated MCP tools-per-server) and shouldn't render
   * as "saved tokens" since the model is conceptually a lower bound.
   */
  unaccountedTokens: number | null;
  /** Number of sessions sampled to produce `observedTokens`. */
  sampleSize: number;
  rows: SourceRow[];
}

export function computeContextOverhead(
  input: ContextOverheadInputs
): ContextOverheadBreakdown {
  const mcpTokens = input.mcpServerCount * MCP_TOKENS_PER_SERVER;
  const skillBytes = input.skills.reduce((acc, s) => acc + (s.fileBytes ?? 0), 0);
  const skillCount = input.skills.length;
  const skillTokens = bytesToTokens(skillBytes);
  const hookCount = input.hookEntries.length;
  const hooksBytes =
    hookCount === 0
      ? 0
      : Buffer.byteLength(JSON.stringify(input.hookEntries), "utf-8");
  const hookTokens = bytesToTokens(hooksBytes);
  const memoryTokens = bytesToTokens(input.memoryBytes);

  const knownTokens =
    SYSTEM_PROMPT_BASELINE_TOKENS +
    mcpTokens +
    skillTokens +
    hookTokens +
    memoryTokens;

  const observedTokens =
    input.observedSamples.length > 0 ? median(input.observedSamples) : null;
  const unaccountedTokens =
    observedTokens !== null ? Math.max(0, observedTokens - knownTokens) : null;

  const rows: SourceRow[] = [
    {
      source: "baseline",
      label: "System prompt baseline",
      tokens: SYSTEM_PROMPT_BASELINE_TOKENS,
      detail: "Claude Code fixed overhead",
    },
    {
      source: "mcp",
      label: "MCP servers",
      tokens: mcpTokens,
      detail:
        input.mcpServerCount === 0
          ? "none"
          : `${pluralize(input.mcpServerCount, "server")} × ~${MCP_TOOLS_PER_SERVER} tools × ${MCP_TOKENS_PER_TOOL}t`,
      actionHref: "/config?type=mcp",
      actionLabel: "Manage MCP servers",
    },
    {
      source: "skills",
      label: "Skills (ceiling)",
      tokens: skillTokens,
      detail:
        skillCount === 0
          ? "none"
          : `${pluralize(skillCount, "skill")} · ${formatBytes(skillBytes)}`,
      actionHref: "/skills",
      actionLabel: "Manage in /skills",
    },
    {
      source: "hooks",
      label: "Hooks",
      tokens: hookTokens,
      detail:
        hookCount === 0
          ? "none"
          : `${pluralize(hookCount, "hook")} · ${formatBytes(hooksBytes)}`,
      actionHref: "/config?type=hooks",
      actionLabel: "Manage hooks",
    },
    {
      source: "memory",
      label: "User CLAUDE.md",
      tokens: memoryTokens,
      detail:
        input.memoryBytes === 0 ? "none" : formatBytes(input.memoryBytes),
      actionHref: "/memory",
      actionLabel: "Edit in /memory",
    },
  ];

  if (unaccountedTokens !== null && unaccountedTokens > 0) {
    rows.push({
      source: "unknown",
      label: "Unaccounted",
      tokens: unaccountedTokens,
      detail: "Observed minus known — sub-agents, conversation, or unmodeled sources",
    });
  }

  return {
    theoreticalMinTokens: SYSTEM_PROMPT_BASELINE_TOKENS,
    knownTokens,
    observedTokens,
    unaccountedTokens,
    sampleSize: input.observedSamples.length,
    rows,
  };
}

export function median(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

function bytesToTokens(bytes: number): number {
  return Math.round(bytes / BYTES_PER_TOKEN);
}

function formatBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}KB`;
  return `${n}B`;
}
