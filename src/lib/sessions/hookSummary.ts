import type { SessionHookRun } from "@/lib/types/session";

/**
 * Per-session hook latency, grouped by command.
 *
 * The Stats page answers "which hooks are slow across all my work"; this
 * answers "what did hooks cost *this* session", which is the question you have
 * while looking at a session that felt sluggish. Both read the same underlying
 * records — `session_hook_runs` via the DB backend, `hookRuns` via the file
 * backend — and both are populated, so this needs no new endpoint and works
 * under `MINDER_USE_DB=0`.
 *
 * Deliberately pure and dependency-free: it must not import from
 * `db/otelQueries.ts`, which is `server-only` and would break the client
 * bundle it renders in.
 */

export interface SessionHookGroup {
  command: string;
  /** Every run of this command, measured or not. */
  fires: number;
  /** How many of `fires` carried a duration. */
  measuredFires: number;
  /** Sum of the measured durations, ms. Excludes unmeasured runs entirely. */
  totalMs: number;
  /** Median of the measured durations. Undefined when none were measured. */
  p50Ms?: number;
  /** Slowest measured run. Undefined when none were measured. */
  maxMs?: number;
}

export interface SessionHookSummary {
  /** Ranked by total measured time descending — the session's actual time sinks. */
  groups: SessionHookGroup[];
  totalFires: number;
  measuredFires: number;
  /** Wall-clock across every measured run in the session, ms. */
  totalMs: number;
}

/**
 * Nearest-rank percentile over a sorted array: the value at 1-based rank
 * `ceil(p/100 * n)`. Matches the rule `otelQueries.percentile` uses, so a
 * session's p50 and the Stats card's p50 mean the same thing. Reimplemented
 * rather than imported because that module is server-only.
 */
function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

export function summarizeSessionHooks(runs: SessionHookRun[] | undefined): SessionHookSummary {
  const byCommand = new Map<string, { fires: number; durations: number[] }>();

  for (const run of runs ?? []) {
    // A record with no command is not attributable to anything — counting it
    // would inflate `totalFires` against a row the reader cannot see.
    if (!run.command) continue;
    const cur = byCommand.get(run.command) ?? { fires: 0, durations: [] };
    cur.fires += 1;
    // `durationMs` is genuinely optional: a large minority of hook records
    // carry a command and no timing. Unmeasured runs count as fires and are
    // excluded from every statistic — treating "not measured" as 0 ms would
    // rank the untimed hooks as the fastest in the session, which is the exact
    // inversion A6 exists to prevent (see SessionHookRun.durationMs).
    if (typeof run.durationMs === "number" && Number.isFinite(run.durationMs)) {
      cur.durations.push(run.durationMs);
    }
    byCommand.set(run.command, cur);
  }

  const groups: SessionHookGroup[] = [];
  for (const [command, v] of byCommand) {
    const sorted = v.durations.slice().sort((a, b) => a - b);
    groups.push({
      command,
      fires: v.fires,
      measuredFires: sorted.length,
      totalMs: sorted.reduce((s, d) => s + d, 0),
      ...(sorted.length
        ? { p50Ms: percentile(sorted, 50), maxMs: sorted[sorted.length - 1] }
        : {}),
    });
  }

  // Total time first — the ranking that answers "where did this session go".
  // Ties fall back to fires so a wholly unmeasured command (totalMs 0) still
  // orders sensibly against its peers rather than by Map insertion order.
  groups.sort((a, b) => b.totalMs - a.totalMs || b.fires - a.fires);

  return {
    groups,
    totalFires: groups.reduce((n, g) => n + g.fires, 0),
    measuredFires: groups.reduce((n, g) => n + g.measuredFires, 0),
    totalMs: groups.reduce((n, g) => n + g.totalMs, 0),
  };
}
