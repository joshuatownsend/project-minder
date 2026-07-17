import "server-only";
import path from "path";
import { promises as fs } from "fs";
import { existsSync, readFileSync } from "fs";
import type DatabaseT from "better-sqlite3";
import { DB_DIR, DB_PATH, getDb, getDbError, closeDb, isDriverLoaded } from "./connection";
import { renameWithRetry } from "../atomicWrite";
import { pruneNotificationLog } from "./maintenance";

// Migration runner for the local SQLite index.
//
// The DB is purely a derived index — it can be rebuilt from the filesystem
// at any time. So our "migration story" is two-track:
//
// 1. **Additive forward migrations.** Adding columns, tables, indexes is
//    cheap. We run pending migrations (those whose version > the recorded
//    `schema_version`) in order at startup. Each is wrapped in a
//    transaction so a half-applied migration is impossible.
//
// 2. **Corruption recovery via rebuild.** If `PRAGMA integrity_check`
//    returns anything other than 'ok' on startup, we close the connection,
//    rename the file aside (`index.db.corrupt-<ts>`), and the indexer
//    rebuilds from scratch on its next sweep. No "repair the DB"
//    machinery — the source of truth is the filesystem.

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseT.Database) => void;
}

/**
 * Migration registry. Append new entries with monotonically increasing
 * versions; never modify or delete an entry once shipped (the DB on
 * someone's machine has already run it).
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    up: (db) => {
      const schemaPath = resolveSchemaPath();
      const sql = readFileSync(schemaPath, "utf-8");
      // better-sqlite3's multi-statement runner. Not child_process — this
      // is the same name happening to be in the SQLite driver's API.
      db.exec(sql);
    },
  },
  {
    version: 2,
    name: "add turns.tool_result_preview",
    up: (db) => {
      // Idempotent: fresh DBs ran the latest schema.sql in v1 which already
      // includes the column. Only existing DBs upgraded from v1 need the
      // ALTER. SQLite doesn't have ADD COLUMN IF NOT EXISTS so we check
      // the current schema before adding.
      const cols = db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "tool_result_preview")) {
        db.exec("ALTER TABLE turns ADD COLUMN tool_result_preview TEXT");
      }
    },
  },
  {
    version: 3,
    name: "add cost_usd / one-shot counts / category_costs rollup",
    up: (db) => {
      // Schema additions that unlock the SQL-aggregate read path on
      // /api/usage (P2b-2.5). All ALTERs are idempotent — fresh DBs got
      // the columns via v1's schema.sql; only DBs upgraded from v1/v2
      // need the structural change.
      //
      // Cost backfill is NOT done here — pricing data lives in JS and is
      // loaded asynchronously, which won't fit a sync migration. Instead
      // we set `meta.needs_reconcile_after_v3 = 1` so the read-side
      // façade falls back to file-parse until the next reconcile (which
      // is forced by the bumped `DERIVED_VERSION` constant) populates
      // `turns.cost_usd` and the rollup. The reconcile clears the flag
      // on success.
      const turnCols = db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
      if (!turnCols.some((c) => c.name === "cost_usd")) {
        db.exec("ALTER TABLE turns ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0");
      }
      const sessionCols = db
        .prepare("PRAGMA table_info(sessions)")
        .all() as Array<{ name: string }>;
      if (!sessionCols.some((c) => c.name === "verified_task_count")) {
        db.exec("ALTER TABLE sessions ADD COLUMN verified_task_count INTEGER NOT NULL DEFAULT 0");
      }
      if (!sessionCols.some((c) => c.name === "one_shot_task_count")) {
        db.exec("ALTER TABLE sessions ADD COLUMN one_shot_task_count INTEGER NOT NULL DEFAULT 0");
      }
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='category_costs'")
        .get() as { name?: string } | undefined;
      if (!tableExists) {
        db.exec(`
          CREATE TABLE category_costs (
            day           TEXT NOT NULL,
            project_slug  TEXT NOT NULL,
            category      TEXT NOT NULL,
            turns         INTEGER NOT NULL DEFAULT 0,
            tokens        INTEGER NOT NULL DEFAULT 0,
            cost_usd      REAL    NOT NULL DEFAULT 0,
            PRIMARY KEY (day, project_slug, category)
          ) WITHOUT ROWID;
          CREATE INDEX category_costs_by_day ON category_costs(day DESC);
        `);
      }
      // Readiness gate: the SQL-aggregate path is unsafe to use until the
      // bumped DERIVED_VERSION drives a full re-parse. Cleared by
      // `reconcileAllSessions` on success. Survives process restarts so
      // a crash mid-rebuild doesn't leave the read path serving zeros.
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('needs_reconcile_after_v3', '1') " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run();
    },
  },
  {
    version: 4,
    name: "drop turns_ad cascade trigger",
    up: (db) => {
      // The AFTER DELETE trigger on `turns` filtered on the UNINDEXED
      // `session_id` / `turn_index` columns of `prompts_fts`, forcing a
      // full table scan per cascade-deleted turn. With ~120k turns and
      // hundreds of cascade deletes per session-replace, that scan
      // dominated reconcile wall-time. `turns` is `WITHOUT ROWID`, so
      // the FTS5 rowid-alignment trick doesn't apply — instead the
      // writer bulk-deletes `prompts_fts` rows for the session in one
      // scan before the cascade.
      db.exec("DROP TRIGGER IF EXISTS turns_ad");
    },
  },
  {
    version: 5,
    name: "sessions: slug + continued_from_session_id",
    up: (db) => {
      // Idempotent ALTER pattern (same as v3): fresh DBs already have the
      // columns from v1's schema.sql; only DBs upgraded from v1–v4 need
      // the structural change. The slug data lives in JSONL — extracting
      // it requires a re-parse — so `DERIVED_VERSION` was bumped to 4 in
      // the same wave; the indexer's mtime+version skip-gate now triggers
      // a one-time full re-parse on existing sessions, populating slug
      // and the post-reconcile `refreshContinuationLinks` UPDATE then
      // wires up `continued_from_session_id`.
      const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "slug")) {
        db.prepare("ALTER TABLE sessions ADD COLUMN slug TEXT").run();
      }
      if (!cols.some((c) => c.name === "continued_from_session_id")) {
        db.prepare("ALTER TABLE sessions ADD COLUMN continued_from_session_id TEXT").run();
      }
      db.prepare(
        "CREATE INDEX IF NOT EXISTS sessions_by_slug ON sessions(slug) WHERE slug IS NOT NULL"
      ).run();
    },
  },
  {
    version: 6,
    name: "sessions: thinking/version/anomaly/compact; turns: duration/thinking",
    up: (db) => {
      // Idempotent ALTER pattern (same as v5): fresh DBs have all columns
      // already; only DBs upgraded from v1–v5 need structural changes.
      const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      if (!sessionCols.some((c) => c.name === "has_thinking")) {
        db.prepare(
          "ALTER TABLE sessions ADD COLUMN has_thinking INTEGER NOT NULL DEFAULT 0 CHECK (has_thinking IN (0,1))"
        ).run();
      }
      if (!sessionCols.some((c) => c.name === "cli_version")) {
        db.prepare("ALTER TABLE sessions ADD COLUMN cli_version TEXT").run();
      }
      if (!sessionCols.some((c) => c.name === "has_resume_anomaly")) {
        db.prepare(
          "ALTER TABLE sessions ADD COLUMN has_resume_anomaly INTEGER NOT NULL DEFAULT 0 CHECK (has_resume_anomaly IN (0,1))"
        ).run();
      }
      if (!sessionCols.some((c) => c.name === "compact_boundary_count")) {
        db.prepare(
          "ALTER TABLE sessions ADD COLUMN compact_boundary_count INTEGER NOT NULL DEFAULT 0"
        ).run();
      }

      const turnCols = db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
      if (!turnCols.some((c) => c.name === "text_offset")) {
        db.prepare("ALTER TABLE turns ADD COLUMN text_offset INTEGER").run();
      }
      if (!turnCols.some((c) => c.name === "turn_duration_ms")) {
        db.prepare("ALTER TABLE turns ADD COLUMN turn_duration_ms INTEGER").run();
      }
      if (!turnCols.some((c) => c.name === "has_thinking")) {
        db.prepare(
          "ALTER TABLE turns ADD COLUMN has_thinking INTEGER NOT NULL DEFAULT 0 CHECK (has_thinking IN (0,1))"
        ).run();
      }
    },
  },
  {
    version: 7,
    name: "wave7.1: generated_title + push_subscriptions + notification_log",
    up: (db) => {
      // Idempotent ALTER for sessions.generated_title (same pattern as v5/v6).
      const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      if (!sessionCols.some((c) => c.name === "generated_title")) {
        db.prepare("ALTER TABLE sessions ADD COLUMN generated_title TEXT").run();
      }
      db.prepare(
        "CREATE INDEX IF NOT EXISTS sessions_by_generated_title ON sessions(generated_title) WHERE generated_title IS NOT NULL"
      ).run();

      // New tables: CREATE IF NOT EXISTS is inherently idempotent.
      db.prepare(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          endpoint      TEXT NOT NULL UNIQUE,
          p256dh        TEXT NOT NULL,
          auth          TEXT NOT NULL,
          user_agent    TEXT,
          created_at    TEXT NOT NULL,
          last_seen_at  TEXT NOT NULL,
          failure_count INTEGER NOT NULL DEFAULT 0
        )
      `).run();

      db.prepare(`
        CREATE TABLE IF NOT EXISTS notification_log (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          channel      TEXT NOT NULL,
          event_key    TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          sent_at      TEXT NOT NULL,
          status       TEXT NOT NULL,
          error        TEXT
        )
      `).run();
      db.prepare(
        "CREATE INDEX IF NOT EXISTS notification_log_dedup ON notification_log(channel, event_key, payload_hash, sent_at)"
      ).run();
    },
  },
  {
    version: 8,
    name: "wave7.1b: starred_at + distilled_at + distilled_text",
    up: (db) => {
      const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      const colNames = sessionCols.map((c) => c.name);
      if (!colNames.includes("starred_at")) {
        db.prepare("ALTER TABLE sessions ADD COLUMN starred_at TEXT").run();
      }
      if (!colNames.includes("distilled_at")) {
        db.prepare("ALTER TABLE sessions ADD COLUMN distilled_at TEXT").run();
      }
      if (!colNames.includes("distilled_text")) {
        db.prepare("ALTER TABLE sessions ADD COLUMN distilled_text TEXT").run();
      }
      db.prepare(
        "CREATE INDEX IF NOT EXISTS sessions_starred ON sessions(starred_at) WHERE starred_at IS NOT NULL"
      ).run();
    },
  },
  {
    version: 9,
    name: "wave8.1a: otel_metrics table",
    up: (db) => {
      // CREATE TABLE IF NOT EXISTS is idempotent: fresh DBs that ran the
      // full schema.sql in v1 (which already includes otel_metrics) will
      // silently no-op here.
      db.prepare(`
        CREATE TABLE IF NOT EXISTS otel_metrics (
          id           INTEGER PRIMARY KEY,
          ts           INTEGER NOT NULL,
          session_id   TEXT,
          metric_name  TEXT NOT NULL,
          metric_type  TEXT NOT NULL CHECK (metric_type IN ('counter', 'gauge')),
          value        REAL NOT NULL,
          model        TEXT,
          attrs_json   TEXT
        )
      `).run();
      db.prepare(
        "CREATE INDEX IF NOT EXISTS otel_metrics_by_name ON otel_metrics(metric_name, ts)"
      ).run();
      db.prepare(
        "CREATE INDEX IF NOT EXISTS otel_metrics_by_session ON otel_metrics(session_id) WHERE session_id IS NOT NULL"
      ).run();
    },
  },
  {
    version: 10,
    name: "wave8.3: work_mode on sessions; error_category + invocation_source on tool_uses",
    up: (db) => {
      const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      const sessionColNames = sessionCols.map((c) => c.name);
      for (const col of [
        "work_mode_exploration_pct REAL",
        "work_mode_building_pct REAL",
        "work_mode_testing_pct REAL",
        "work_mode_other_pct REAL",
      ]) {
        const name = col.split(" ")[0];
        if (!sessionColNames.includes(name)) {
          db.prepare(`ALTER TABLE sessions ADD COLUMN ${col}`).run();
        }
      }

      const tuCols = db.prepare("PRAGMA table_info(tool_uses)").all() as Array<{ name: string }>;
      const tuColNames = tuCols.map((c) => c.name);
      if (!tuColNames.includes("error_category")) {
        db.prepare("ALTER TABLE tool_uses ADD COLUMN error_category TEXT").run();
      }
      if (!tuColNames.includes("invocation_source")) {
        db.prepare(
          "ALTER TABLE tool_uses ADD COLUMN invocation_source TEXT CHECK (invocation_source IN ('slash_command','auto'))"
        ).run();
      }
    },
  },
  {
    version: 11,
    name: "wave10.2a: source column on sessions (multi-platform adapter)",
    up: (db) => {
      const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      const sessionColNames = sessionCols.map((c) => c.name);
      if (!sessionColNames.includes("source")) {
        db.prepare("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'claude'").run();
      }
      db.prepare(
        "CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source)"
      ).run();
    },
  },
  {
    version: 12,
    name: "wave11.1a: mcp security scanner tables",
    up: (db) => {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS mcp_scan_runs (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at_ms   INTEGER NOT NULL,
          duration_ms     INTEGER NOT NULL,
          servers_scanned INTEGER NOT NULL,
          findings_count  INTEGER NOT NULL,
          trigger         TEXT NOT NULL CHECK (trigger IN ('scan','manual','startup'))
        )
      `).run();

      db.prepare(`
        CREATE TABLE IF NOT EXISTS mcp_scan_findings (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id        INTEGER NOT NULL,
          server_id     TEXT NOT NULL,
          scope         TEXT NOT NULL CHECK (scope IN ('user','project')),
          project_slug  TEXT,
          rule_id       TEXT NOT NULL,
          category      TEXT NOT NULL,
          severity      TEXT NOT NULL CHECK (severity IN ('crit','high','med','low','info')),
          surface       TEXT NOT NULL CHECK (surface IN ('command','args','url','env','name','tool-desc','param-name')),
          surface_ref   TEXT,
          message       TEXT NOT NULL,
          evidence      TEXT,
          found_at_ms   INTEGER NOT NULL,
          FOREIGN KEY (run_id) REFERENCES mcp_scan_runs(id) ON DELETE CASCADE
        )
      `).run();

      db.prepare(
        "CREATE INDEX IF NOT EXISTS idx_mcp_scan_findings_server ON mcp_scan_findings(server_id)"
      ).run();
      db.prepare(
        "CREATE INDEX IF NOT EXISTS idx_mcp_scan_findings_run ON mcp_scan_findings(run_id)"
      ).run();

      db.prepare(`
        CREATE TABLE IF NOT EXISTS mcp_tool_fingerprints (
          server_id        TEXT NOT NULL,
          tool_name        TEXT NOT NULL,
          description_hash TEXT NOT NULL,
          first_seen_ms    INTEGER NOT NULL,
          last_seen_ms     INTEGER NOT NULL,
          PRIMARY KEY (server_id, tool_name)
        )
      `).run();
    },
  },
  {
    version: 13,
    name: "memory observatory: memory_usage table for memory read telemetry",
    up: (db) => {
      // Write-through from src/lib/memory/usageTracker; reads come from the
      // in-memory cache, so this table is a durable backing store for
      // future trend queries rather than a primary read path.
      db.prepare(`
        CREATE TABLE IF NOT EXISTS memory_usage (
          abs_path         TEXT PRIMARY KEY,
          read_count       INTEGER NOT NULL DEFAULT 0,
          last_read_at     TEXT,
          last_updated_at  TEXT NOT NULL
        )
      `).run();
      db.prepare(
        "CREATE INDEX IF NOT EXISTS idx_memory_usage_last_read ON memory_usage(last_read_at DESC)"
      ).run();
    },
  },
  {
    version: 14,
    name: "T2.2: session_prs table for gh pr create → session reverse-index",
    up: (db) => {
      // Created idempotently with IF NOT EXISTS — same posture as the
      // other Wave-N migrations so a partially-applied schema doesn't
      // brick the indexer. INSERT OR IGNORE on the PK keeps repeated
      // tail-appends and reconciles idempotent (the extractor re-runs
      // on every parse; existing rows survive a NOOP).
      db.prepare(`
        CREATE TABLE IF NOT EXISTS session_prs (
          session_id   TEXT NOT NULL,
          pr_url       TEXT NOT NULL,
          pr_number    INTEGER NOT NULL,
          repo         TEXT NOT NULL,
          PRIMARY KEY (session_id, pr_url),
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        ) WITHOUT ROWID
      `).run();
      db.prepare(
        "CREATE INDEX IF NOT EXISTS session_prs_by_url ON session_prs(pr_url)"
      ).run();
    },
  },
  {
    version: 15,
    name: "item3: session_tickets table for issue/ticket URL reverse-index",
    up: (db) => {
      // Same posture as session_prs (v14): idempotent IF NOT EXISTS so a
      // partially-applied schema doesn't brick the indexer, INSERT OR
      // IGNORE on the PK keeps tail-appends and reconciles idempotent.
      // DERIVED_VERSION is bumped to 9 in the same change so the existing
      // corpus is re-parsed once and backfilled (newly-modified sessions
      // alone would otherwise be the only ones populating this table).
      db.prepare(`
        CREATE TABLE IF NOT EXISTS session_tickets (
          session_id   TEXT NOT NULL,
          url          TEXT NOT NULL,
          provider     TEXT NOT NULL,
          ticket_key   TEXT NOT NULL,
          PRIMARY KEY (session_id, url),
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        ) WITHOUT ROWID
      `).run();
      db.prepare(
        "CREATE INDEX IF NOT EXISTS session_tickets_by_url ON session_tickets(url)"
      ).run();
    },
  },
  {
    version: 16,
    name: "item4b: project_grade_snapshots table for daily efficiency-grade trends",
    up: (db) => {
      // Idempotent IF NOT EXISTS — fresh DBs already have this table from
      // v1's schema.sql; only DBs upgraded from <16 need the create. The
      // composite PK (project_slug, snapshot_date) doubles as the index for
      // the "most-recent snapshot before today" trend lookup, so no separate
      // index is needed. No DERIVED_VERSION bump: snapshots are forward-only
      // (trend history accrues from first run, never backfilled).
      db.prepare(`
        CREATE TABLE IF NOT EXISTS project_grade_snapshots (
          project_slug   TEXT NOT NULL,
          snapshot_date  TEXT NOT NULL,
          grade          TEXT NOT NULL,
          high_count     INTEGER NOT NULL DEFAULT 0,
          med_count      INTEGER NOT NULL DEFAULT 0,
          low_count      INTEGER NOT NULL DEFAULT 0,
          created_at_ms  INTEGER NOT NULL,
          PRIMARY KEY (project_slug, snapshot_date)
        ) WITHOUT ROWID
      `).run();
    },
  },
  {
    version: 17,
    name: "A1: turns.is_sidechain — persist subagent turns so their cost folds into usage totals",
    up: (db) => {
      // Subagent (Task/sidechain) assistant turns are now stored as `turns`
      // rows (is_sidechain=1) so their tokens/cost appear in the usage totals.
      // Existing rows are all primary → default 0 is correct with no backfill;
      // DERIVED_VERSION 10 drives a re-parse that adds the new sidechain rows
      // for sessions that used subagents. Guarded so a fresh DB (column already
      // present from schema.sql) doesn't error.
      const cols = db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "is_sidechain")) {
        db.prepare(
          "ALTER TABLE turns ADD COLUMN is_sidechain INTEGER NOT NULL DEFAULT 0"
        ).run();
      }
    },
  },
];

function resolveSchemaPath(): string {
  // The compiled output of this module lives next to schema.sql, so
  // __dirname/schema.sql is the canonical lookup. Fallback walks up
  // looking for src/lib/db/schema.sql so tests run from any cwd find it.
  const sibling = path.join(__dirname, "schema.sql");
  if (existsSync(sibling)) return sibling;
  // turbopackIgnore: this cwd-walk is a dev/test-only fallback (the
  // __dirname lookup above is what production and the standalone build
  // use). Without the ignore comment, Turbopack's file tracer can't
  // prove the loop is bounded and falls back to including every file
  // reachable from the project root in every route's output trace —
  // ballooning `.next/standalone` from a pruned few dozen MB to the
  // entire repo (src/, tests/, docs/, site/, etc.). See
  // https://nextjs.org/docs/messages/nft-unexpected-file-traced-in-nft-list
  let dir = /* turbopackIgnore: true */ process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(/* turbopackIgnore: true */ dir, "src", "lib", "db", "schema.sql");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("schema.sql not found; expected at src/lib/db/schema.sql");
}

/**
 * Sentinel error used to signal "the meta table tells us this DB has
 * already been initialized but its schema_version stamp is missing or
 * unreadable." Distinguishable by initDb() so it can route to the
 * quarantine-and-rebuild path rather than blindly re-running v1 (which
 * would fail with "table already exists").
 */
class SchemaVersionMissingError extends Error {
  readonly schemaVersionMissing = true as const;
  constructor(message: string) {
    super(message);
    this.name = "SchemaVersionMissingError";
  }
}

function getCurrentVersion(db: DatabaseT.Database): number {
  // The first migration creates the meta table, so on a fresh DB the
  // table won't exist yet — that's the signal to start at 0.
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
    .get() as { name?: string } | undefined;
  if (!row) return 0;
  const versionRow = db
    .prepare("SELECT value FROM meta WHERE key='schema_version'")
    .get() as { value?: string } | undefined;
  if (!versionRow) {
    // meta exists but the stamp is gone. Re-running v1 would fail with
    // "table already exists" because v1's schema.sql is plain CREATE
    // TABLE statements. Treat as corruption — caller quarantines.
    throw new SchemaVersionMissingError(
      "meta table present but schema_version row missing"
    );
  }
  const parsed = parseInt(versionRow.value!, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SchemaVersionMissingError(
      `meta.schema_version is unreadable: ${JSON.stringify(versionRow.value)}`
    );
  }
  return parsed;
}

function setCurrentVersion(db: DatabaseT.Database, version: number): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(version));
}

/**
 * Run any migrations whose version is greater than the recorded
 * `schema_version`. Each migration runs inside its own transaction so a
 * thrown migration leaves the previous version intact.
 */
function applyPendingMigrations(db: DatabaseT.Database): { applied: number[]; current: number } {
  const current = getCurrentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version
  );
  const applied: number[] = [];
  for (const migration of pending) {
    const txn = db.transaction(() => {
      migration.up(db);
      setCurrentVersion(db, migration.version);
    });
    txn();
    applied.push(migration.version);
  }
  return { applied, current: getCurrentVersion(db) };
}

/**
 * Move WAL/SHM siblings of `DB_PATH` to `dest` siblings (rename) or
 * delete them outright. Leftover WAL on a fresh DB at the same path
 * causes "database disk image is malformed" on next open, so a sibling
 * that won't move and won't delete is genuinely dangerous.
 *
 * The rename path uses `renameWithRetry` because WAL/SHM hold the same
 * Windows file-lock-release-lag as the main DB. If retries exhaust, we
 * fall back to delete — losing forensic snapshots of the WAL beats
 * leaving a poison pill in place.
 */
async function moveOrDeleteSiblings(dest: string | null): Promise<void> {
  for (const ext of [".wal", ".shm"]) {
    const src = DB_PATH + ext;
    if (dest) {
      try {
        await renameWithRetry(src, dest + ext);
        continue;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue; // didn't exist, fine
        // Rename gave up — fall through to delete so the rebuilt DB
        // doesn't reopen against a stale WAL.
      }
    }
    try {
      await fs.rm(src, { force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* may not exist or genuinely stuck — best effort */
    }
  }
}

/**
 * Rename a corrupt DB file aside. The next `getDb()` will open a fresh
 * empty DB at the same path; the indexer rebuilds the contents.
 *
 * On Windows, file handles release asynchronously after close — see
 * `renameWithRetry` for the retry rationale. If rename still fails after
 * the retry budget we fall back to deleting the file: forensic
 * preservation is nice-to-have, clearing the slot for rebuild is the
 * must-have.
 */
async function quarantineCorruptDb(reason: string): Promise<string | null> {
  // No `fs.access` pre-check — rename's ENOENT path tells us "nothing to
  // quarantine" without a TOCTOU window.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(DB_DIR, `index.db.corrupt-${stamp}`);

  try {
    await renameWithRetry(DB_PATH, dest);
    await moveOrDeleteSiblings(dest);
    // eslint-disable-next-line no-console
    console.warn(`[db] Quarantined corrupt index to ${dest} (${reason}). Will rebuild.`);
    return dest;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null; // nothing to quarantine
    // Rename gave up after retries (still locked, or some other failure).
    // Fall back to outright delete so the rebuild can proceed.
    try {
      await fs.rm(DB_PATH, { force: true, maxRetries: 10, retryDelay: 100 });
      await moveOrDeleteSiblings(null);
      // eslint-disable-next-line no-console
      console.warn(
        `[db] Could not preserve corrupt index (rename kept failing): ${(err as Error).message}. ` +
          `Deleted instead so rebuild can proceed.`
      );
      return null;
    } catch {
      throw err; // bubble the original symptom
    }
  }
}

export interface InitResult {
  available: boolean;
  appliedMigrations: number[];
  schemaVersion: number;
  quarantined: string | null;
  error: Error | null;
}

/**
 * Open the DB, run integrity check, apply pending migrations. Idempotent —
 * call from indexer startup and from any read-side path that wants the
 * DB ready before its first query.
 *
 * Recovery paths:
 *   0. Driver missing (`isDriverLoaded() === false`) — return cleanly
 *      with `available: false` and no quarantine. The caller (read-side
 *      façade) falls back to file-parse mode. We never quarantine here
 *      because the file isn't necessarily corrupt — the platform just
 *      lacks the binary.
 *   1. `getDb()` returns null with driver loaded — assume corruption,
 *      quarantine and reopen once.
 *   2. `PRAGMA quick_check` returns non-'ok' — quarantine and reopen.
 *   3. `getCurrentVersion` throws SchemaVersionMissingError — meta table
 *      exists but stamp is gone; re-running v1 would fail with "table
 *      already exists." Quarantine and reopen.
 *   4. Migration throws (non-corruption) — bubbled up as `result.error`.
 *
 * The indexer is responsible for repopulating the rebuilt DB.
 */
export async function initDb(): Promise<InitResult> {
  const result: InitResult = {
    available: false,
    appliedMigrations: [],
    schemaVersion: 0,
    quarantined: null,
    error: null,
  };

  // Path 0: driver missing. Don't quarantine — the file is fine, the
  // platform just lacks the native binary. Surface the underlying load
  // error so debug surfaces can distinguish "no binary" from "broken DB".
  if (!isDriverLoaded()) {
    const cause = getDbError();
    result.error = new Error("better-sqlite3 driver unavailable on this platform", {
      cause: cause ?? undefined,
    });
    return result;
  }

  let db = await getDb();
  if (!db) {
    // Path 1: driver loaded but open threw. Most common cause is a
    // corrupt file from a previous unclean shutdown. Try to quarantine
    // and reopen once.
    result.quarantined = await quarantineCorruptDb("open failed; possible corruption");
    db = await getDb();
    if (!db) {
      result.error = new Error("DB failed to open after quarantine", {
        cause: getDbError() ?? undefined,
      });
      return result;
    }
  }

  // Path 2: quick_check on every open. quick_check is materially cheaper
  // than integrity_check (skips index/UNIQUE cross-checks) and catches the
  // same corruption classes that matter for a derived index — page-level
  // damage and freelist breakage. We can rebuild from the JSONLs anyway,
  // so we don't need integrity_check's index-level assurance on startup.
  const integrity = db.prepare("PRAGMA quick_check").get() as {
    quick_check?: string;
  };
  if (integrity.quick_check !== "ok") {
    closeDb();
    result.quarantined = await quarantineCorruptDb(
      `quick_check returned ${integrity.quick_check}`
    );
    db = await getDb();
    if (!db) {
      result.error = new Error("Failed to reopen DB after quarantine", {
        cause: getDbError() ?? undefined,
      });
      return result;
    }
  }

  try {
    const { applied, current } = applyPendingMigrations(db);
    result.available = true;
    result.appliedMigrations = applied;
    result.schemaVersion = current;
    pruneNotificationLog(db);
    return result;
  } catch (err) {
    // Path 3: SchemaVersionMissingError — meta table exists but stamp is
    // missing. Quarantine and retry once. Any other error bubbles.
    if (err instanceof SchemaVersionMissingError) {
      closeDb();
      result.quarantined = await quarantineCorruptDb(`schema_version unreadable: ${err.message}`);
      const reopened = await getDb();
      if (!reopened) {
        result.error = new Error("Failed to reopen DB after schema_version quarantine", {
          cause: getDbError() ?? undefined,
        });
        return result;
      }
      try {
        const { applied, current } = applyPendingMigrations(reopened);
        result.available = true;
        result.appliedMigrations = applied;
        result.schemaVersion = current;
        return result;
      } catch (retryErr) {
        result.error = retryErr as Error;
        return result;
      }
    }
    result.error = err as Error;
    return result;
  }
}
