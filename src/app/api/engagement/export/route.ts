import { NextRequest, NextResponse } from "next/server";
import { validatePeriod } from "@/lib/usage/constants";
import { getEngagement, DbUnavailableError } from "@/lib/data";
import { resolveEngagementConfig } from "@/lib/engagement/config";
import type { EngagementReport } from "@/lib/engagement/types";
import { demoMode } from "@/lib/demo/demoMode";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { normalizePathKey } from "@/lib/platform";

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

/**
 * Every row carries the same three columns, including the provenance block.
 *
 * A trailing metadata section with a different column count is well-formed
 * enough for a spreadsheet but trips strict RFC-4180 parsers and several
 * import tools — and this file exists to be imported into someone else's
 * timekeeping system, so the padding is worth more than the tidiness.
 */
const CSV_COLUMNS = 4;

function csvRow(cells: (string | number)[]): string {
  const padded = [...cells];
  while (padded.length < CSV_COLUMNS) padded.push("");
  return padded.map(csvCell).join(",");
}

function toCsv(report: EngagementReport): string {
  const lines: string[] = [];
  // `home` is a column rather than an afterthought: two Claude homes can hold
  // the same encoded project path, and the report deliberately keeps them as
  // separate billing identities. Serializing only the directory would produce
  // duplicate, indistinguishable rows in the one artifact that gets invoiced.
  // Empty for the ordinary single-home case.
  lines.push(csvRow(["date", "project", "home", "hours"]));
  for (const day of report.byDay) {
    for (const entry of day.byProject) {
      lines.push(csvRow([
        day.date,
        entry.projectDirName,
        entry.homeKey ?? "",
        entry.hours.toFixed(2),
      ]));
    }
  }
  lines.push(csvRow([""]));
  lines.push(csvRow(["# provenance"]));
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
  for (const [k, v] of meta) lines.push(csvRow([k, v]));
  return lines.join("\r\n");
}

/** Longest any single component may contribute, applied *before* sanitizing
 *  so the work is bounded by a constant rather than by request input. */
const MAX_PART_LEN = 64;

/**
 * Strip leading and trailing `-` without a regex.
 *
 * The obvious `/^-+|-+$/` is a **polynomial ReDoS** on this input: the `-+$`
 * alternative retries from every position in a long dash run, and `project`
 * is attacker-controlled (CodeQL `js/polynomial-redos`, flagged on PR #418).
 * Two pointers are linear and cannot backtrack at all.
 */
function trimDashes(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) === 45) a++;
  while (b > a && s.charCodeAt(b - 1) === 45) b--;
  return s.slice(a, b);
}

/**
 * Build a safe `Content-Disposition` filename.
 *
 * `project` is a raw query parameter that reaches this header, so a CR or LF
 * in it would split the response; quotes and path separators break the header
 * or the saved name on some clients. Everything outside a conservative
 * allowlist collapses to `-`, mirroring the sessions export route, and the
 * result is length-bounded so a long parameter cannot produce an unusable
 * filename.
 */
function safeFilename(parts: (string | undefined)[]): string {
  const cleaned = parts
    .filter((p): p is string => !!p)
    // Truncate first: the allowlist replace is linear, but bounding the input
    // keeps total work constant regardless of what the caller sends.
    .map((p) => trimDashes(p.slice(0, MAX_PART_LEN).replace(/[^A-Za-z0-9._-]+/g, "-")))
    .filter(Boolean)
    .join("_");
  return (cleaned || "timecard").slice(0, 120);
}

/** Exported for tests only — filename sanitization is security-relevant
 *  (header injection + ReDoS), so it is pinned directly rather than inferred
 *  from a route response. */
export const __testing = { safeFilename, trimDashes };

export async function GET(request: NextRequest) {
  // Same two gates as the read route. A CSV is the most durable artifact this
  // feature produces — a demo-mode export would put real billable hours in a
  // file that outlives the session it was taken from.
  if (await demoMode()) {
    return NextResponse.json(
      { error: "engagement-unavailable", message: "The engagement report isn't available in demo mode." },
      { status: 503 }
    );
  }
  const appConfig = await readConfig();
  if (!getFlag(appConfig.featureFlags, "engagementReport")) {
    return NextResponse.json(
      { error: "engagement-unavailable", message: "The engagement report is turned off in Settings." },
      { status: 503 }
    );
  }

  const params = request.nextUrl.searchParams;
  const period = validatePeriod(params.get("period") || "30d");
  const project = params.get("project") || undefined;
  const timeZone = resolveTimeZone(params.get("tz"));
  const rawHome = params.get("home") || undefined;
  const home = rawHome ? normalizePathKey(rawHome) : undefined;
  const format = params.get("format") === "json" ? "json" : "csv";

  const config = resolveEngagementConfig({
    responseThresholdMs: minutesParam(params.get("responseMinutes")),
    runCapMs: minutesParam(params.get("runCapMinutes")),
    tailCreditMs: minutesParam(params.get("tailMinutes")),
  });

  let report: EngagementReport;
  try {
    ({ report } = await getEngagement(period, timeZone, config, project, home));
  } catch (error) {
    if (error instanceof DbUnavailableError) {
      // `reason` too, exactly as `/api/engagement` returns it: "still indexing"
      // and "the index is switched off" are different answers to "why is there
      // no CSV", and a caller that can only read the prose has to guess (#470).
      return NextResponse.json(
        { error: "engagement-unavailable", message: error.message, reason: error.reason },
        { status: 503 }
      );
    }
    throw error;
  }

  const stamp = report.byDay.length
    ? `${report.byDay[0].date}_${report.byDay[report.byDay.length - 1].date}`
    : period;
  const base = safeFilename(["timecard", project, stamp]);

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
