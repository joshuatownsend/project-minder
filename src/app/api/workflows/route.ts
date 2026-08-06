import { NextRequest } from "next/server";
import { jsonWithCacheControl } from "@/lib/httpCache";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { walkClaudeWorkflows } from "@/lib/indexer/walkWorkflows";

/**
 * C1 — the Claude Code workflow catalog.
 *
 * Returns the bare array, matching `/api/skills` and `/api/agents`. That is a
 * documented gotcha in this repo rather than an oversight: those routes unwrap
 * their loader's `{ data }` envelope, and a client parsing `body.data` gets
 * `undefined` (bit PR #272). Kept consistent so the three catalogs behave alike.
 */
export async function GET(request: NextRequest) {
  const config = await readConfig();
  if (!getFlag(config.featureFlags, "workflowCatalog")) {
    return jsonWithCacheControl([]);
  }

  const query = request.nextUrl.searchParams.get("q")?.toLowerCase().trim();
  let entries = await walkClaudeWorkflows();

  if (query) {
    entries = entries.filter((e) =>
      [e.name, e.description, e.whenToUse]
        .filter(Boolean)
        .some((field) => (field as string).toLowerCase().includes(query))
    );
  }

  // Strip the two fields no list view reads. `scriptExcerpt` is the obvious
  // one; `runs` is the bigger problem in the case this feature explicitly
  // supports — a workflow repeated across thousands of sessions carries a runs
  // array far larger than the capped excerpt, and every element ships an
  // absolute script path, a session id and a task id to a client that only
  // wanted the count (Codex review of #389). The detail route keeps both.
  return jsonWithCacheControl(
    entries.map(({ scriptExcerpt, runs, ...rest }) => {
      void scriptExcerpt;
      void runs;
      return rest;
    })
  );
}
