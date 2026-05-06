import { NextRequest, NextResponse } from "next/server";
import { loadPluginRollup } from "@/lib/data/pluginRollup";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.toLowerCase() ?? undefined;

  let rows = await loadPluginRollup();

  if (q) {
    rows = rows.filter((r) =>
      [r.plugin.name, r.plugin.marketplace, r.plugin.version]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }

  return NextResponse.json(rows);
}
