import { NextRequest } from "next/server";
import { jsonWithCacheControl } from "@/lib/httpCache";
import { loadAgentsResponse } from "@/lib/server/queries/agents";
import { catalogHomeErrorResponse, setUnresolvedPluginsHeader } from "@/lib/server/catalogHomeHttp";

// The whole response body lives in `@/lib/server/queries/agents` so the RSC
// prefetch (PR 3) shares the cache + catalog/usage join + filter chain. Re-export
// the cache invalidator so existing importers (`/api/scan`) are unaffected.
export { invalidateAgentsRouteCache } from "@/lib/server/queries/agents";

export async function GET(request: NextRequest) {
  const source = request.nextUrl.searchParams.get("source");
  const projectSlug = request.nextUrl.searchParams.get("project");
  const query = request.nextUrl.searchParams.get("q");
  // `home`: another Claude home's catalog, by key (#553). Usage stats are
  // joined for the primary home only — see `loadAgentsResponse`.
  const home = request.nextUrl.searchParams.get("home");

  let loaded;
  try {
    loaded = await loadAgentsResponse(source, projectSlug, query, home);
  } catch (err) {
    return catalogHomeErrorResponse(err);
  }
  const { data, backend, unresolvedPlugins } = loaded;

  const response = jsonWithCacheControl(data);
  response.headers.set("X-Minder-Backend", backend);
  setUnresolvedPluginsHeader(response, unresolvedPlugins);
  return response;
}
