import { NextRequest, NextResponse } from "next/server";
import { generateUsageReport } from "@/lib/usage/aggregator";
import { validatePeriod } from "@/lib/usage/constants";
import { normalizePathKey } from "@/lib/platform";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const safePeriod = validatePeriod(params.get("period") || "month");
  const project = params.get("project") || undefined;
  const format = params.get("format") || "json";
  // Claude-home discriminator (#311) — see the /api/usage route.
  const rawHome = params.get("home") || undefined;
  const home = rawHome ? normalizePathKey(rawHome) : undefined;

  const report = await generateUsageReport(safePeriod, project, undefined, home);

  if (format === "csv") {
    const header = "date,cost,inputTokens,outputTokens,turns";
    const rows = report.daily.map(
      (d) =>
        `${d.date},${d.cost.toFixed(6)},${d.inputTokens},${d.outputTokens},${d.turns}`
    );
    const csv = [header, ...rows].join("\n");

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="usage-report-${safePeriod}.csv"`,
      },
    });
  }

  // JSON export
  return new NextResponse(JSON.stringify(report, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="usage-report-${safePeriod}.json"`,
    },
  });
}
