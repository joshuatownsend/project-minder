import { NextRequest } from "next/server";
import { jsonWithCacheControl } from "@/lib/httpCache";
import { loadSkillsResponse } from "@/lib/server/queries/skills";

// The whole response body lives in `@/lib/server/queries/skills` so the RSC
// prefetch (PR 3) shares the cache + catalog/usage join + filter + DB
// invocation-source augmentation. Re-export the cache invalidator so existing
// importers (`/api/scan`, `/api/skills/[id]/toggle`) are unaffected.
export { invalidateSkillsRouteCache } from "@/lib/server/queries/skills";

export async function GET(request: NextRequest) {
  const source = request.nextUrl.searchParams.get("source");
  const projectSlug = request.nextUrl.searchParams.get("project");
  const query = request.nextUrl.searchParams.get("q");

  const { data, backend } = await loadSkillsResponse(source, projectSlug, query);

  const response = jsonWithCacheControl(data);
  response.headers.set("X-Minder-Backend", backend);
  return response;
}
