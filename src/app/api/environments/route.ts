import "server-only";
import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { demoMode } from "@/lib/demo/demoMode";
import { loadEnvironments } from "@/lib/environments/inventory";
import { getOrCreateRouteCache } from "@/lib/routeCache";
import type { EnvironmentsPayload } from "@/lib/environments/diff";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = getOrCreateRouteCache<EnvironmentsPayload>("environments", { ttlMs: CACHE_TTL_MS });

export function invalidateEnvironmentsRouteCache() {
  cache.clear();
}

/**
 * GET /api/environments
 *
 * What each readable Claude home has installed — user agents, skills,
 * plugins, and MCP server names — plus the homes that could not be read this
 * cycle and why. Drives the Environments tab on `/group/<slug>`, which diffs
 * the homes a group's locations live under (`src/lib/environments/diff.ts`).
 *
 * Mirrors `/api/claude-homes`: the demo short-circuit sits ABOVE `readConfig`
 * so a demo viewer never causes a home path to be read or a `wsl.exe` probe
 * to run, and only `partitionClaudeHomes(...).readable` is ever touched (the
 * never-wake invariant, #307/#308). A demo machine has synthetic projects and
 * no real homes, so the honest demo answer is no homes at all — the tab
 * renders its empty state rather than a fixture that would imply a
 * comparison exists.
 */
export async function GET(): Promise<NextResponse> {
  if (await demoMode()) {
    return NextResponse.json({ homes: [], unavailable: [] } satisfies EnvironmentsPayload);
  }
  const payload = await cache.getOrLoad("all", async () => loadEnvironments(await readConfig()));
  return NextResponse.json(payload);
}
