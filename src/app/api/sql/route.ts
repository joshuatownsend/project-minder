import { NextRequest, NextResponse } from "next/server";
import { getDb, getDbError, isDriverLoaded } from "@/lib/db/connection";

// Read-only ad-hoc SQL endpoint against the local SQLite index.
//
// **No auth.** Project Minder is a local-only dashboard with no auth on
// any endpoint by design; the SQL route follows that convention. Do not
// add auth-style checks here without auditing the rest of the app.
//
// **SELECT-only.** Two-layer enforcement:
//   1. Regex on the first non-whitespace keyword rejects the obvious
//      writes / DDL / PRAGMA / ATTACH / VACUUM. Cheap pre-filter that
//      keeps clearly-bad queries from ever reaching the engine.
//   2. `db.prepare(sql).readonly` — better-sqlite3 introspects the
//      compiled statement and reports whether it can mutate. Authoritative
//      check that catches the weird cases the regex won't (e.g. user-written
//      table-valued functions, future SQLite syntax).
//
// **Row clamp 10 000.** Iterate-and-stop rather than rewriting the query
// to inject a LIMIT. Avoids SQL-rewriting headaches with CTEs / set-ops
// and gives the same protection.
//
// **Failure modes**
//   - Driver missing or DB not initialized → 503 with `{error, reason}`.
//     Distinct from query errors so the UI / debug surfaces can show
//     "indexer hasn't run yet" vs "your query is wrong."
//   - Disallowed statement → 400 with `{error: "only SELECT…"}`.
//   - Malformed / unknown-table SQL → 400 with the SQLite message.
//
// Accepts both `GET /api/sql?sql=…` (handy for curl) and
// `POST /api/sql {sql, params?}` (for longer queries and bound params).

export const MAX_ROWS = 10_000;
// First non-whitespace token must be SELECT or WITH (CTE → SELECT).
// All other leading keywords (INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/
// ATTACH/DETACH/PRAGMA/VACUUM/REINDEX/REPLACE/TRUNCATE/BEGIN/COMMIT/
// ROLLBACK/SAVEPOINT/RELEASE/ANALYZE) get rejected. Comments and
// leading whitespace are stripped before the check.
const ALLOWED_LEAD_RE = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*\s*(SELECT|WITH)\b/i;

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// Plain object check — admits `{}` and `Object.create(null)` literals,
// rejects class instances (Date, Map, Set, RegExp, etc.) which would
// crash better-sqlite3's bind path with confusing low-level errors.
function isPlainParamsObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

interface SqlSuccess {
  rows: unknown[];
  rowCount: number;
  truncated: boolean;
  columns: string[];
  durationMs: number;
}

interface SqlError {
  error: string;
  reason?: string;
}

export async function GET(request: NextRequest) {
  const sql = request.nextUrl.searchParams.get("sql");
  if (!sql) return badRequest("missing 'sql' query param");
  return runQuery(sql, undefined);
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("body must be JSON");
  }
  if (!body || typeof body !== "object") return badRequest("body must be a JSON object");
  const { sql, params } = body as { sql?: unknown; params?: unknown };
  if (typeof sql !== "string" || sql.length === 0) return badRequest("missing 'sql' field");
  if (params !== undefined && !Array.isArray(params) && !isPlainParamsObject(params)) {
    return badRequest("'params' must be an array or plain object");
  }
  return runQuery(sql, params as unknown[] | Record<string, unknown> | undefined);
}

async function runQuery(
  sql: string,
  params: unknown[] | Record<string, unknown> | undefined
): Promise<NextResponse<SqlSuccess | SqlError>> {
  if (!ALLOWED_LEAD_RE.test(sql)) {
    return badRequest("only SELECT statements are allowed");
  }

  // Distinguish "driver missing" from "DB hasn't opened yet" so the UI
  // can surface a useful hint.
  if (!isDriverLoaded()) {
    return dbUnavailable("better-sqlite3 native binary not loaded on this platform");
  }
  const db = await getDb();
  if (!db) {
    return dbUnavailable(getDbError()?.message ?? "DB not initialized");
  }

  let stmt;
  try {
    stmt = db.prepare(sql);
  } catch (err) {
    return badRequest(errorMessage(err));
  }

  // Two orthogonal checks here, NOT a redundant safety:
  //   `stmt.reader`   — statement returns rows (a SELECT-like). False
  //                     for things like a no-op PRAGMA that the regex
  //                     gate wouldn't catch if it ever slipped through.
  //   `stmt.readonly` — statement cannot mutate the DB. False for a
  //                     `WITH ... INSERT ... RETURNING` CTE (the regex
  //                     gate accepts the WITH lead but the statement
  //                     does write).
  // SELECT-only intent requires both: must return rows AND must not
  // mutate.
  if (!stmt.reader || !stmt.readonly) {
    return badRequest("only read-only SELECT statements are allowed");
  }

  const t0 = Date.now();
  const rows: unknown[] = [];
  let truncated = false;
  const iter = params === undefined ? stmt.iterate() : stmt.iterate(params);
  try {
    for (const row of iter) {
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
  } catch (err) {
    iter.return?.();
    return badRequest(errorMessage(err));
  }
  // Explicitly finalize the iterator on early break too — better-sqlite3
  // GCs eventually, but explicit cleanup releases the prepared-statement
  // step state immediately.
  if (truncated) iter.return?.();
  const durationMs = Date.now() - t0;

  // Best-effort column list. better-sqlite3's `columns()` works for
  // SELECTs that return at least one resultset; failures here are
  // non-fatal.
  let columns: string[] = [];
  try {
    columns = stmt.columns().map((c) => c.name);
  } catch {
    /* swallow — column metadata is best-effort */
  }

  return NextResponse.json<SqlSuccess>({
    rows,
    rowCount: rows.length,
    truncated,
    columns,
    durationMs,
  });
}

function badRequest(message: string): NextResponse<SqlError> {
  return NextResponse.json<SqlError>({ error: message }, { status: 400 });
}

function dbUnavailable(reason: string): NextResponse<SqlError> {
  return NextResponse.json<SqlError>(
    { error: "db unavailable", reason },
    { status: 503 }
  );
}
