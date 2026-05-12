import { NextRequest, NextResponse } from "next/server";
import { getHookBuffer } from "@/lib/hooks/buffer";

// Returns the last 30 hook events for a project slug.
// Used by AgentPeekPanel — first UI consumer of the hook ring buffer.

export async function GET(request: NextRequest): Promise<NextResponse> {
  const slug = request.nextUrl.searchParams.get("slug") ?? "";
  const hookEvents = [...getHookBuffer(slug)];
  return NextResponse.json({ hookEvents });
}
