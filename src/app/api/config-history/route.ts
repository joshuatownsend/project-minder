import { NextRequest, NextResponse } from "next/server";
import { list } from "@/lib/configHistory";

export async function GET(request: NextRequest) {
  const projectSlug = request.nextUrl.searchParams.get("project") || undefined;
  try {
    const entries = await list({ projectSlug });
    return NextResponse.json({ entries });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
