import "server-only";
import type DatabaseT from "better-sqlite3";
import { prepCached } from "@/lib/db/connection";
import type { AgentStats } from "@/lib/usage/types";

// SQL-backed agent usage loader for `/api/agents` and
// `/api/agents/[id]`. Mirrors `groupAgentCalls(allTurns)` from
// `src/lib/usage/agentParser.ts` but reads from indexed `tool_uses`
// rows instead of rehydrating every UsageTurn from JSONL via
// `parseAllSessions`.
//
// Single SQL query: GROUP BY (agent_name, project_slug, session_id),
// fanned out in JS into the AgentStats[] shape — invocations summed
// per (agent), projects map summed per (agent, project), sessions[]
// derived from per-(agent, session) latest timestamp sorted DESC and
// capped at 50.
//
// **No documented divergences** vs the file-parse path: both backends
// skip sidechain entries (parser.ts:103 for file-parse, ingest for DB),
// and `agent_name` is extracted identically (`args.subagent_type` —
// see `src/lib/db/ingest.ts:217` and `agentParser.ts:13`). The
// invocations / projects / sessions maps should agree exactly when the
// indexer is up-to-date with the on-disk JSONL.

interface Row {
  agent_name: string;
  project_slug: string | null;
  session_id: string;
  n: number;
  first_ts: string | null;
  last_ts: string | null;
}

/**
 * Build the AgentStats[] list from indexed `tool_uses` rows. Returns
 * `[]` when no Agent invocations are indexed; caller's façade promotes
 * this to a fall-through so a brand-new install with the indexer still
 * warming up doesn't show "no agents used" when JSONL files exist.
 */
export function loadAgentUsageFromDb(db: DatabaseT.Database): AgentStats[] {
  const rows = prepCached(
    db,
    `SELECT tu.agent_name AS agent_name,
            s.project_slug AS project_slug,
            tu.session_id AS session_id,
            COUNT(*) AS n,
            MIN(tu.ts) AS first_ts,
            MAX(tu.ts) AS last_ts
     FROM tool_uses tu
     JOIN sessions s USING (session_id)
     WHERE tu.tool_name = 'Agent' AND tu.agent_name IS NOT NULL
     GROUP BY tu.agent_name, s.project_slug, tu.session_id`
  ).all() as Row[];

  if (rows.length === 0) return [];

  // Per-agent aggregation. `sessionMaxTs` tracks the latest ts per
  // (agent, session) so we can produce the top-50 sessions[] list
  // sorted DESC — matches `groupAgentCalls`'s sessionTimes shape.
  const byAgent = new Map<string, AgentStats>();
  const sessionMaxTs = new Map<string, Map<string, string>>();

  for (const row of rows) {
    const agent = row.agent_name;
    let stat = byAgent.get(agent);
    if (!stat) {
      stat = { name: agent, invocations: 0, projects: {}, sessions: [] };
      byAgent.set(agent, stat);
      sessionMaxTs.set(agent, new Map());
    }

    stat.invocations += row.n;

    if (row.first_ts && (!stat.firstUsed || row.first_ts < stat.firstUsed)) {
      stat.firstUsed = row.first_ts;
    }
    if (row.last_ts && (!stat.lastUsed || row.last_ts > stat.lastUsed)) {
      stat.lastUsed = row.last_ts;
    }

    // project_slug is nullable in schema but ingest sets it from
    // `toSlug(projectDirName)`, so it should always be a string in
    // practice. Defensive empty-string for null matches the file-
    // parse `turn.projectSlug` shape (UsageTurn always has a string).
    const projectKey = row.project_slug ?? "";
    stat.projects[projectKey] = (stat.projects[projectKey] ?? 0) + row.n;

    if (row.last_ts) {
      const times = sessionMaxTs.get(agent)!;
      const prev = times.get(row.session_id) ?? "";
      if (row.last_ts > prev) times.set(row.session_id, row.last_ts);
    } else {
      // Ensure the session is represented even when ts is null — matches
      // file-parse's `times.set(turn.sessionId, turn.timestamp ?? "")`.
      const times = sessionMaxTs.get(agent)!;
      if (!times.has(row.session_id)) times.set(row.session_id, "");
    }
  }

  for (const stat of byAgent.values()) {
    const times = sessionMaxTs.get(stat.name)!;
    stat.sessions = [...times.entries()]
      .sort((a, b) => b[1].localeCompare(a[1]))
      .slice(0, 50)
      .map(([id]) => id);
  }

  return Array.from(byAgent.values()).sort((a, b) => b.invocations - a.invocations);
}
