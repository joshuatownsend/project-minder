import { NextRequest, NextResponse } from "next/server";
import { loadCommandsResponse } from "@/lib/server/queries/commands";

// The whole response body lives in `@/lib/server/queries/commands` so the RSC
// prefetch (PR 3) shares the route-level cache + command walk + filter chain.
// Re-export the cache invalidator so existing importers (`src/lib/template/apply.ts`,
// `src/app/api/config-history/restore/route.ts`) are unaffected.
export { invalidateCommandsRouteCache } from "@/lib/server/queries/commands";

export async function GET(request: NextRequest) {
  const source = request.nextUrl.searchParams.get("source");
  const projectSlug = request.nextUrl.searchParams.get("project");
  const query = request.nextUrl.searchParams.get("q");

  const rows = await loadCommandsResponse(source, projectSlug, query);
  return NextResponse.json(rows);
}
