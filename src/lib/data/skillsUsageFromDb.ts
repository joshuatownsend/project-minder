import "server-only";
import type DatabaseT from "better-sqlite3";
import { prepCached } from "@/lib/db/connection";
import type { SkillStats } from "@/lib/usage/types";

// SQL-backed skill usage loader for `/api/skills` and
// `/api/skills/[id]`. Mirror of `loadAgentUsageFromDb` against
// `tool_uses.skill_name`. Replaces the
// `parseAllSessions` + `groupSkillCalls` rehydrate (`skillParser.ts`).
//
// Single SQL query: GROUP BY (skill_name, project_slug, session_id),
// fanned out in JS into the SkillStats[] shape — invocations summed
// per (skill), projects map summed per (skill, project), sessions[]
// derived from per-(skill, session) latest timestamp sorted DESC and
// capped at 50.
//
// **No documented divergences** vs the file-parse path: both backends
// skip sidechain entries (parser.ts:103 for file-parse, ingest for
// DB), and `skill_name` is extracted identically (`args.skill` —
// see `src/lib/db/ingest.ts:223` and `skillParser.ts:13`). The SQL
// filter mirrors `groupSkillCalls`'s string-existence check
// (`if (typeof skillName !== "string" || !skillName) continue`) — the
// `tu.skill_name <> ''` predicate matches the falsy-string branch so
// stray empty skill_name rows don't synthesize a phantom "" skill
// under DB mode that file-parse would have skipped. The invocations /
// projects / sessions maps should agree exactly when the indexer is
// up-to-date with the on-disk JSONL.

interface Row {
  skill_name: string;
  project_slug: string | null;
  session_id: string;
  n: number;
  first_ts: string | null;
  last_ts: string | null;
}

/**
 * Build the SkillStats[] list from indexed `tool_uses` rows. Returns
 * `[]` when no Skill invocations are indexed; caller's façade promotes
 * this to a fall-through so a brand-new install with the indexer still
 * warming up doesn't show "no skills used" when JSONL files exist.
 *
 * @param sinceIso Optional ISO8601 lower bound on `tu.ts`. Filters
 *   invocations to those at or after the timestamp. `tu.ts` is stored
 *   as ISO8601 TEXT and sorts lexicographically, so the predicate is
 *   index-friendly. Omit for all-time stats.
 */
export function loadSkillUsageFromDb(db: DatabaseT.Database, sinceIso?: string): SkillStats[] {
  const sinceClause = sinceIso ? " AND tu.ts >= ?" : "";
  const stmt = prepCached(
    db,
    `SELECT tu.skill_name AS skill_name,
            s.project_slug AS project_slug,
            tu.session_id AS session_id,
            COUNT(*) AS n,
            MIN(tu.ts) AS first_ts,
            MAX(tu.ts) AS last_ts
     FROM tool_uses tu
     JOIN sessions s USING (session_id)
     WHERE tu.tool_name = 'Skill' AND tu.skill_name IS NOT NULL AND tu.skill_name <> ''${sinceClause}
     GROUP BY tu.skill_name, s.project_slug, tu.session_id`
  );
  const rows = (sinceIso ? stmt.all(sinceIso) : stmt.all()) as Row[];

  // NOTE: no early return on `rows.length === 0`.
  //
  // There used to be one, and it silently defeated A4. `rows` counts explicit
  // `Skill` dispatches; attribution lives on `turns` and has a genuinely
  // different population — a skill can drive thousands of turns of spend
  // without inference ever recording an invocation, which is the entire reason
  // A4 exists. Returning early on an empty invocation set skipped the
  // attribution query below, handed the façade an empty list, and made it fall
  // back to the file backend — so the DB path reported no attributed skills at
  // all. The empty-result contract the façade relies on is preserved: if
  // neither query finds anything, this still returns `[]`.
  //
  // Per-skill aggregation — same shape as `groupSkillCalls`'s
  // sessionTimes map in `src/lib/usage/skillParser.ts`.
  const bySkill = new Map<string, SkillStats>();
  const sessionMaxTs = new Map<string, Map<string, string>>();

  for (const row of rows) {
    const skill = row.skill_name;
    let stat = bySkill.get(skill);
    if (!stat) {
      stat = { name: skill, invocations: 0, projects: {}, sessions: [] };
      bySkill.set(skill, stat);
      sessionMaxTs.set(skill, new Map());
    }

    stat.invocations += row.n;

    if (row.first_ts && (!stat.firstUsed || row.first_ts < stat.firstUsed)) {
      stat.firstUsed = row.first_ts;
    }
    if (row.last_ts && (!stat.lastUsed || row.last_ts > stat.lastUsed)) {
      stat.lastUsed = row.last_ts;
    }

    const projectKey = row.project_slug ?? "";
    stat.projects[projectKey] = (stat.projects[projectKey] ?? 0) + row.n;

    if (row.last_ts) {
      const times = sessionMaxTs.get(skill)!;
      const prev = times.get(row.session_id) ?? "";
      if (row.last_ts > prev) times.set(row.session_id, row.last_ts);
    } else {
      const times = sessionMaxTs.get(skill)!;
      if (!times.has(row.session_id)) times.set(row.session_id, "");
    }
  }

  for (const stat of bySkill.values()) {
    const times = sessionMaxTs.get(stat.name)!;
    stat.sessions = [...times.entries()]
      .sort((a, b) => b[1].localeCompare(a[1]))
      .slice(0, 50)
      .map(([id]) => id);
  }

  // A4: attributed spend, from `turns.attribution_skill`. A separate query
  // because it groups over `turns`, not `tool_uses` — and the populations
  // genuinely differ: a skill can drive spend without inference ever recording
  // an invocation, which is exactly the gap A4 exists to close.
  const attrClause = sinceIso ? " AND t.ts >= ?" : "";
  const attrStmt = prepCached(
    db,
    `SELECT t.attribution_skill AS skill_name,
            COUNT(*) AS turns,
            COALESCE(SUM(t.cost_usd), 0) AS cost
     FROM turns t
     WHERE t.role = 'assistant'
       AND t.attribution_skill IS NOT NULL AND t.attribution_skill <> ''${attrClause}
     GROUP BY 1`
  );
  const attrRows = (sinceIso ? attrStmt.all(sinceIso) : attrStmt.all()) as Array<{
    skill_name: string; turns: number; cost: number;
  }>;

  for (const r of attrRows) {
    let stat = bySkill.get(r.skill_name);
    if (!stat) {
      // Attributed but never invoked through the Skill tool — still a real
      // skill with real spend, so it gets a row rather than being dropped.
      stat = { name: r.skill_name, invocations: 0, projects: {}, sessions: [] };
      bySkill.set(r.skill_name, stat);
    }
    stat.attributedCostUsd = r.cost;
    stat.attributedTurns = r.turns;
  }

  return Array.from(bySkill.values()).sort((a, b) => b.invocations - a.invocations);
}
