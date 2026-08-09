import { NextRequest, NextResponse } from "next/server";
import { validatePeriod } from "@/lib/usage/constants";
import { getEngagement, DbUnavailableError } from "@/lib/data";
import { resolveEngagementConfig } from "@/lib/engagement/config";
import type { EngagementReport } from "@/lib/engagement/types";

/**
 * CSV / JSON export — the artifact that actually gets filed.
 *
 * One row per (local day × project) so it pastes straight into a timecard
 * without further arithmetic, plus a trailing provenance block recording the
 * thresholds the numbers were produced with. That block is the point: a
 * billable figure a client can question needs to travel with the definition
 * that produced it.
 */

function resolveTimeZone(requested: string | null): string {
  const server = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (!requested) return server;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: requested }).format(0);
    return requested;
  } catch {
    return server;
  }
}

function minutesParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n * 60_000 : undefined;
}

/**
 * RFC-4180 quoting, plus a leading apostrophe on anything a spreadsheet would
 * evaluate. Project keys are filesystem-derived and a name beginning `-` or
 * `=` is a formula-injection vector the moment the CSV is opened in Excel.
 */
function csvCell(value: string | number): string {
  const s = String(value);
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function toCsv(report: EngagementReport): string {
  const lines: string[] = [];
  lines.push(["date", "project", "hours"].map(csvCell).join(","));
  for (const day of report.byDay) {
    for (const entry of day.byProject) {
      lines.push([day.date, entry.projectDirName, entry.hours.toFixed(2)].map(csvCell).join(","));
    }
  }
  lines.push("");
  lines.push([csvCell("# provenance"), csvCell("")].join(","));
  const meta: [string, string | number][] = [
    ["period", report.period],
    ["timezone", report.timeZone],
    ["billable hours (de-overlapped)", report.totalHours.toFixed(2)],
    ["raw hours (before overlap discount)", report.rawHours.toFixed(2)],
    ["overlap discount", report.overlapHours.toFixed(2)],
    ["idle threshold (minutes)", report.config.responseThresholdMs / 60_000],
    ["agent-run cap (minutes)", report.config.runCapMs / 60_000],
    ["tail credit (minutes)", report.config.tailCreditMs / 60_000],
    ["automated sessions excluded", report.excludedAutomatedSessions],
  ];
  for (const [k, v] of meta) lines.push([k, v].map(csvCell).join(","));
  return lines.join("\r\n");
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const period = validatePeriod(params.get("period") || "30d");
  const project = params.get("project") || undefined;
  const timeZone = resolveTimeZone(params.get("tz"));
  const format = params.get("format") === "json" ? "json" : "csv";

  const config = resolveEngagementConfig({
    responseThresholdMs: minutesParam(params.get("responseMinutes")),
    runCapMs: minutesParam(params.get("runCapMinutes")),
    tailCreditMs: minutesParam(params.get("tailMinutes")),
  });

  let report: EngagementReport;
  try {
    ({ report } = await getEngagement(period, timeZone, config, project));
  } catch (error) {
    if (error instanceof DbUnavailableError) {
      return NextResponse.json(
        { error: "engagement-unavailable", message: error.message },
        { status: 503 }
      );
    }
    throw error;
  }

  const stamp = report.byDay.length
    ? `${report.byDay[0].date}_${report.byDay[report.byDay.length - 1].date}`
    : period;
  const base = `timecard_${project ? `${project}_` : ""}${stamp}`;

  if (format === "json") {
    return new NextResponse(JSON.stringify(report, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${base}.json"`,
      },
    });
  }

  return new NextResponse(toCsv(report), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${base}.csv"`,
    },
  });
}
