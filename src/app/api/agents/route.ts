import { NextRequest } from "next/server";
import { jsonWithCacheControl } from "@/lib/httpCache";
import { loadAgentsResponse } from "@/lib/server/queries/agents";

// The whole response body lives in `@/lib/server/queries/agents` so the RSC
// prefetch (PR 3) shares the cache + catalog/usage join + filter chain. Re-export
// the cache invalidator so existing importers (`/api/scan`) are unaffected.
export { invalidateAgentsRouteCache } from "@/lib/server/queries/agents";

export async function GET(request: NextRequest) {
  const source = request.nextUrl.searchParams.get("source");
  const projectSlug = request.nextUrl.searchParams.get("project");
  const query = request.nextUrl.searchParams.get("q");

  const { data, backend } = await loadAgentsResponse(source, projectSlug, query);

  const response = jsonWithCacheControl(data);
  response.headers.set("X-Minder-Backend", backend);
  return response;
}
