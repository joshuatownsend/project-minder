import "server-only";
import { getDb, prepCached } from "@/lib/db/connection";

/**
 * A6 — permission denials, and what they cost.
 *
 * Claude Code records *why* a tool call was refused in `toolDenialKind`, which
 * A1 stored on `tool_uses.denial_kind`. The vocabulary observed locally:
 *
 *   permission-rule       a configured rule refused it
 *   automode-blocked      the auto-mode classifier refused it
 *   automode-unavailable  auto mode could not decide
 *   user-rejected         a human said no
 *
 * **Keeping `user-rejected` separate is the point.** Claude Code 2.1.216 fixed
 * its own telemetry miscounting permission denials as user rejections, and the
 * two mean opposite things: a rule denial is configuration the user can change,
 * a human rejection is the user disagreeing with the model. Collapsing them
 * produces a "your rules are too strict" reading of what was actually a person
 * saying no, or the reverse.
 */
export interface DenialKindRow {
  kind: string;
  /** Denied tool calls of this kind. */
  denials: number;
  /** Distinct sessions in which this kind occurred. */
  sessions: number;
  /** The tools most often refused this way, biggest first. */
  topTools: Array<{ tool: string; denials: number }>;
  /**
   * Tasks that were **started** by a turn which also had a call denied this
   * way, and whose outcome was recorded. `undefined` when no such task exists —
   * which is not the same as zero.
   */
  verifiedTasks?: number;
  /** How many of those passed first time. */
  oneShotTasks?: number;
}

export interface DenialBreakdown {
  kinds: DenialKindRow[];
  totalDenials: number;
  /**
   * False when no denial has ever been recorded. Distinguishes "nothing was
   * ever refused" from "this index predates `denial_kind`", which the caller
   * must not render as a clean bill of health.
   */
  hasData: boolean;
}

/**
 * Denials grouped by kind, crossed with first-pass success.
 *
 * The cross is the A6 half of the `task_outcome` reuse A2 built the column for.
 * A2 deliberately made it a general turn-level join key rather than an
 * effort-shaped rollup precisely so this query is a JOIN and not a second
 * rollup table. The question it answers: does being refused actually derail the
 * work, or does the model route around it? A kind with many denials and an
 * unchanged first-pass rate is friction; one that tanks the rate is a rule
 * worth revisiting.
 *
 * Attribution follows A2's rule exactly — `task_outcome` sits on the turn that
 * *started* the task, so a denial counts against a task only when it happened
 * on that same turn. A denial three turns later belongs to whatever that turn
 * started, not to this one.
 */
export async function getDenialBreakdown(opts: {
  since?: string;
  project?: string;
} = {}): Promise<DenialBreakdown> {
  const db = await getDb();
  if (!db) return { kinds: [], totalDenials: 0, hasData: false };

  const params = {
    since: opts.since ?? null,
    project: opts.project ?? null,
  };

  const rows = prepCached(
    db,
    `SELECT tu.denial_kind                                   AS kind,
            COUNT(*)                                         AS denials,
            COUNT(DISTINCT tu.session_id)                    AS sessions
       FROM tool_uses tu
       JOIN sessions s ON s.session_id = tu.session_id
      WHERE tu.denial_kind IS NOT NULL AND tu.denial_kind <> ''
        AND (@since IS NULL OR tu.ts >= @since)
        AND (@project IS NULL OR s.project_slug = @project)
      GROUP BY 1
      ORDER BY denials DESC`
  ).all(params) as Array<{ kind: string; denials: number; sessions: number }>;

  if (rows.length === 0) return { kinds: [], totalDenials: 0, hasData: false };

  const toolRows = prepCached(
    db,
    `SELECT tu.denial_kind AS kind, tu.tool_name AS tool, COUNT(*) AS denials
       FROM tool_uses tu
       JOIN sessions s ON s.session_id = tu.session_id
      WHERE tu.denial_kind IS NOT NULL AND tu.denial_kind <> ''
        AND tu.tool_name IS NOT NULL AND tu.tool_name <> ''
        AND (@since IS NULL OR tu.ts >= @since)
        AND (@project IS NULL OR s.project_slug = @project)
      GROUP BY 1, 2
      ORDER BY 1, denials DESC`
  ).all(params) as Array<{ kind: string; tool: string; denials: number }>;

  // The cross with A2's `turns.task_outcome`. DISTINCT on (session, turn) is
  // load-bearing: a turn can have several calls denied the same way, and each
  // one would otherwise re-count that turn's single task outcome — inflating
  // both numerator and denominator by the same factor, which leaves the RATE
  // looking right while the sample size is a fiction.
  const outcomeRows = prepCached(
    db,
    `SELECT kind,
            COUNT(*)                                  AS verifiedTasks,
            SUM(CASE WHEN outcome = 'one_shot' THEN 1 ELSE 0 END) AS oneShotTasks
       FROM (
         SELECT DISTINCT tu.denial_kind AS kind,
                t.session_id            AS sid,
                t.turn_index            AS ti,
                t.task_outcome          AS outcome
           FROM tool_uses tu
           JOIN turns t
             ON t.session_id = tu.session_id AND t.turn_index = tu.turn_index
           JOIN sessions s ON s.session_id = t.session_id
          WHERE tu.denial_kind IS NOT NULL AND tu.denial_kind <> ''
            AND t.task_outcome IS NOT NULL
            AND (@since IS NULL OR t.ts >= @since)
            AND (@project IS NULL OR s.project_slug = @project)
       )
      GROUP BY kind`
  ).all(params) as Array<{ kind: string; verifiedTasks: number; oneShotTasks: number }>;

  const toolsByKind = new Map<string, Array<{ tool: string; denials: number }>>();
  for (const r of toolRows) {
    const list = toolsByKind.get(r.kind) ?? [];
    if (list.length < 5) list.push({ tool: r.tool, denials: r.denials });
    toolsByKind.set(r.kind, list);
  }
  const outcomeByKind = new Map(outcomeRows.map((r) => [r.kind, r]));

  const kinds: DenialKindRow[] = rows.map((r) => {
    const o = outcomeByKind.get(r.kind);
    return {
      kind: r.kind,
      denials: r.denials,
      sessions: r.sessions,
      topTools: toolsByKind.get(r.kind) ?? [],
      // Left undefined rather than 0 when no denied turn started a verified
      // task. "No sample" and "a sample that never passed" are opposite
      // readings, and 0 would also sort below a kind that genuinely failed
      // everything.
      verifiedTasks: o ? o.verifiedTasks : undefined,
      oneShotTasks: o ? o.oneShotTasks : undefined,
    };
  });

  return {
    kinds,
    totalDenials: rows.reduce((sum, r) => sum + r.denials, 0),
    hasData: true,
  };
}
