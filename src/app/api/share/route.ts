import { NextRequest, NextResponse } from "next/server";
import { validatePeriod } from "@/lib/usage/constants";
import { getUsage } from "@/lib/data";
import { composeShareSvg } from "@/lib/shareImage";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const period = validatePeriod(searchParams.get("period") ?? "month");
  const theme = searchParams.get("theme") === "light" ? "light" : "dark";
  const project = searchParams.get("project") ?? undefined;
  const source = searchParams.get("source") ?? undefined;
  const width = parseInt(searchParams.get("width") ?? "1200", 10);

  const { report } = await getUsage(period, project, source);
  const svg = composeShareSvg(report, { theme, period, width: isNaN(width) ? 1200 : Math.min(Math.max(width, 400), 2400) });

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "private, max-age=60",
    },
  });
}
