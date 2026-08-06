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

  // The script excerpt is the largest field by far and no list view uses it, so
  // it is dropped here rather than shipped to every client that only wanted names.
  return jsonWithCacheControl(entries.map(({ scriptExcerpt, ...rest }) => rest));
}
