/**
 * #395 — rolling a session's delegation counts up over its whole subagent tree.
 *
 * Claude Code's caps are per **session**; the counts on a session summary are
 * per **root turn set**. When a subagent itself spawns an agent or runs a web
 * search, those calls happen against the same cap and were invisible here — so
 * the badge stayed silent in precisely the runaway-delegation case it exists to
 * warn about.
 *
 * Pure: Maps in, counts out. The DB layer supplies the maps; keeping the
 * arithmetic out of the query means the tree rule can be tested against a shape
 * rather than against an index that has to be built first.
 *
 * ## Why a session's own sidechain counts are included
 *
 * Both transcript layouts are handled by the same sum. Modern Claude Code writes
 * a subagent to `<parent>/subagents/agent-*.jsonl`, which ingests as a child
 * session; older builds inlined the subagent's turns into the parent file, where
 * they land as sidechain turns of the root itself. Adding both means neither
 * layout needs its own code path — and on a corpus that has only one of them,
 * the other term is simply zero.
 */

/**
 * `sessions.derived_version` at which `parent_session_id` and
 * `sidechain_tool_counts` began to be written.
 *
 * Compared with `>=`, never `===`. An equality gate against the current
 * `DERIVED_VERSION` would make every session read as unmeasured the moment an
 * unrelated bump shipped, and — the sharper failure — it is the same
 * non-directional comparison that once let an older tray "refresh" 5,001
 * freshly-derived sessions backwards (see `derivationVersion.ts`).
 */
export const TREE_DELEGATION_MIN_DERIVED_VERSION = 20;

/**
 * Tool names that count as a subagent spawn.
 *
 * `Agent` is what Claude Code actually emits — measured across 1,260 subagent
 * transcripts: 62 `Agent`, 0 `Task`. `Task` is the name the tool wears in the
 * product's own docs and in older transcripts, so it is accepted too; a name
 * that never appears costs one Map lookup, while omitting a name that does
 * appear costs a silently low count.
 */
export const SPAWN_TOOL_NAMES = ["Agent", "Task"] as const;

/**
 * Tool names that count against the web-search cap.
 *
 * `WebSearch` only — deliberately NOT `WebFetch`, even though nested `WebFetch`
 * calls are common (68 locally against 123 `WebSearch`). The count this feeds
 * has always meant `WebSearch`, and widening the tree dimension and the tool set
 * in the same change would make a moved number impossible to attribute to
 * either. If Claude Code's cap does turn out to cover fetches, adding the name
 * here is a one-line change — that is the point of storing observed names rather
 * than pre-resolved buckets.
 */
export const WEB_SEARCH_TOOL_NAMES = ["WebSearch"] as const;

/** Per-session tool tallies, keyed by session id then tool name. */
export type ToolCountsBySession = Map<string, Record<string, number>>;

export interface DelegationTreeSource {
  /** `sessions.derived_version`, for every session in the index. */
  derivedVersion: Map<string, number>;
  /** Child session ids per parent, from `sessions.parent_session_id`. */
  childrenByParent: Map<string, string[]>;
  /** Tool calls on primary turns (`tool_uses`), per session. */
  primaryTools: ToolCountsBySession;
  /** Tool calls on subagent turns (`sidechain_tool_counts`), per session. */
  sidechainTools: ToolCountsBySession;
}

export interface TreeDelegationCounts {
  /** Subagent spawns across the root session and every transcript below it. */
  spawns: number;
  /** Web searches across the root session and every transcript below it. */
  webSearches: number;
  /** Sessions summed, including the root. 1 means "no subagent transcripts". */
  sessionCount: number;
}

function sumNames(counts: Record<string, number> | undefined, names: readonly string[]): number {
  if (!counts) return 0;
  let total = 0;
  for (const name of names) total += counts[name] ?? 0;
  return total;
}

/**
 * Tree totals for one root session, or `undefined` when the tree cannot be
 * counted honestly.
 *
 * **Undefined is not zero, and it is not "fall back to the root count".** A
 * session stamped below {@link TREE_DELEGATION_MIN_DERIVED_VERSION} was parsed
 * by a build that never looked for subagent transcripts, so its children are
 * unknown rather than absent; returning the root-only number would present a
 * partial count in a field whose whole purpose is to be complete. The same
 * applies to a single stale child — one unrefreshed transcript makes the total
 * a lower bound, not a total.
 *
 * The residual gap is one-directional and stays: a subagent transcript that was
 * never indexed at all is invisible to this, so a returned total can still
 * under-count. It cannot over-count. That direction matters — the badge this
 * feeds says a session "may have been silently truncated", and under-warning
 * costs a missing badge while over-warning asserts something that did not
 * happen.
 */
export function rollUpTreeDelegation(
  rootSessionId: string,
  src: DelegationTreeSource
): TreeDelegationCounts | undefined {
  const rootVersion = src.derivedVersion.get(rootSessionId);
  if (rootVersion === undefined || rootVersion < TREE_DELEGATION_MIN_DERIVED_VERSION) {
    return undefined;
  }

  const ids = [rootSessionId, ...(src.childrenByParent.get(rootSessionId) ?? [])];

  let spawns = 0;
  let webSearches = 0;
  for (const id of ids) {
    const version = src.derivedVersion.get(id);
    if (version === undefined || version < TREE_DELEGATION_MIN_DERIVED_VERSION) {
      return undefined;
    }
    const primary = src.primaryTools.get(id);
    const sidechain = src.sidechainTools.get(id);
    spawns += sumNames(primary, SPAWN_TOOL_NAMES) + sumNames(sidechain, SPAWN_TOOL_NAMES);
    webSearches +=
      sumNames(primary, WEB_SEARCH_TOOL_NAMES) + sumNames(sidechain, WEB_SEARCH_TOOL_NAMES);
  }

  return { spawns, webSearches, sessionCount: ids.length };
}
