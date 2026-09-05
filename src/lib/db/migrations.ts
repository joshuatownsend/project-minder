import "server-only";
import path from "path";
import { promises as fs } from "fs";
import { existsSync, readFileSync, statSync } from "fs";
import type DatabaseT from "better-sqlite3";
import { DB_DIR, DB_PATH, getDb, getDbError, closeDb, isDriverLoaded } from "./connection";
import {
  clearCleanShutdownMarker,
  quickCheckForced,
  readCleanShutdownState,
  shouldRunQuickCheck,
} from "./cleanShutdown";
import { renameWithRetry } from "../atomicWrite";
import { resolveServerRoot } from "../serverRoot";
import { sessionFileHomeKey } from "../platform";
import { pruneNotificationLog } from "./maintenance";
import { serviceLog } from "@/lib/serviceLog";

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
  {
    version: 18,
    name: "#311: sessions.home_key — Claude-home provenance for per-project usage/cost filtering",
    up: (db) => {
      // Two configured Claude homes with identical path layouts (Ubuntu +
      // Debian both /home/josh/dev/foo) produce the same project_slug, so
      // `/api/usage?project=` mixed their spend. home_key records which home
      // owns each session so the read side can discriminate.
      const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "home_key")) {
        db.prepare("ALTER TABLE sessions ADD COLUMN home_key TEXT").run();
      }
      // Backfill from file_path — the owning home is a path prefix of every
      // Claude session file (`<home>/projects/…`), i.e. location-derived,
      // NOT content-derived. That's what makes this a plain backfill instead
      // of a DERIVED_VERSION bump: no JSONL re-parse is needed, and fresh
      // ingests stamp the identical value via the same helper.
      const rows = db
        .prepare(
          "SELECT session_id, file_path FROM sessions WHERE source = 'claude' AND home_key IS NULL"
        )
        .all() as Array<{ session_id: string; file_path: string }>;
      const update = db.prepare("UPDATE sessions SET home_key = ? WHERE session_id = ?");
      for (const r of rows) {
        const homeKey = sessionFileHomeKey(r.file_path);
        if (homeKey) update.run(homeKey, r.session_id);
      }
    },
  },
  {
    version: 19,
    name: "chunked full-body prompts_fts — drop turn triggers, add chunk_index, force reindex",
    up: (db) => {
      // `prompts_fts` mirrored `turns.text_preview` (500 chars), so most of
      // what any substantial turn said was silently unsearchable. It now
      // holds FULL turn bodies (prose + extended thinking) split into
      // overlapping chunks — one FTS row per chunk.
      //
      // Three things have to happen together, and none of them is optional:
      //
      // 1. DROP the triggers. They can't express the new behaviour: the
      //    full body is never stored in `turns` (only the 500-char preview
      //    is), so a trigger has nothing to read. The writer owns
      //    population now.
      //
      // 2. RECREATE the table. FTS5 virtual tables do not support
      //    `ALTER TABLE ... ADD COLUMN`, so adding `chunk_index` means drop
      //    and create. Dropping also discards the old preview rows, which
      //    is required rather than merely convenient — leaving them would
      //    mix 500-char documents in with ~4000-char ones under bm25's
      //    length normalization and quietly skew every ranking.
      //
      // 3. FORCE a re-parse. This is why DERIVED_VERSION goes to 12 in the
      //    same change. Re-deriving from stored columns CANNOT repopulate
      //    this index — the text simply isn't in the database. Only a
      //    genuine JSONL re-read can, and `derived_version` staleness is
      //    the mechanism that triggers one (see derivationVersion.ts).
      //
      // Until that reconcile completes, prompt-scope search returns fewer
      // hits than it will afterwards. That is degraded, not wrong: title
      // -scope search is unaffected, and no result returned during the
      // window is incorrect. Chose that over a read-side gate because a
      // gate would make search return NOTHING during catch-up, which is a
      // worse experience than returning less.
      db.exec("DROP TRIGGER IF EXISTS turns_ai");
      db.exec("DROP TRIGGER IF EXISTS turns_au");
      db.exec("DROP TABLE IF EXISTS prompts_fts");
      db.exec(`
        CREATE VIRTUAL TABLE prompts_fts USING fts5(
          session_id   UNINDEXED,
          turn_index   UNINDEXED,
          chunk_index  UNINDEXED,
          role         UNINDEXED,
          ts           UNINDEXED,
          text,
          tokenize='porter unicode61'
        )
      `);
    },
  },
  {
    version: 20,
    name: "A1: transcript schema decode — effort, causal attribution, session kind, hook runs, permission modes",
    up: (db) => {
      // Claude Code's transcript grew a set of fields Minder decoded none of.
      // This migration only makes room for them; DERIVED_VERSION 13 in the same
      // change is what actually re-reads the JSONL to fill them. Splitting those
      // two would leave the columns permanently NULL on existing history.
      //
      // Every ALTER is guarded by a PRAGMA check so re-running is a no-op —
      // the same idempotency contract migrations 17/18 established. Column adds
      // in SQLite are non-rewriting metadata updates, so an abort mid-migration
      // leaves earlier statements applied and the guards make the retry clean.
      const hasCol = (table: string, col: string) =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .some((c) => c.name === col);
      const addCol = (table: string, col: string, decl: string) => {
        if (!hasCol(table, col)) {
          db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`).run();
        }
      };

      // Per-turn. `effort` drives A2's cost-by-reasoning-effort analytics.
      addCol("turns", "effort", "TEXT");
      // Causal cost attribution: which skill/MCP server made this turn's tokens
      // exist. Deliberately NOT merged into the existing tool_uses.skill_name /
      // mcp_server, which are inferred from the `mcp__server__tool` naming
      // convention and answer a different question ("was this call a skill
      // invocation?"). Conflating them attributes every turn after a tool
      // result to that server instead of only the turns that consumed it.
      addCol("turns", "attribution_skill", "TEXT");
      addCol("turns", "attribution_mcp_server", "TEXT");
      addCol("turns", "attribution_mcp_tool", "TEXT");

      // Per-session.
      addCol("sessions", "session_kind", "TEXT");
      addCol("sessions", "ai_title", "TEXT");
      addCol("sessions", "entrypoint", "TEXT");

      // Why a tool call was refused: permission-rule | automode-blocked |
      // user-rejected | automode-unavailable. Feeds A6's denial analytics.
      addCol("tool_uses", "denial_kind", "TEXT");

      // Hook runs and permission-mode changes are one-to-many per session, so
      // they are tables rather than columns. No FK to sessions: ingest writes
      // turns before the session row is finalised in some paths, and a
      // constraint violation there would abort an otherwise good ingest.
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_hook_runs (
          session_id  TEXT NOT NULL,
          ts          TEXT,
          command     TEXT NOT NULL,
          duration_ms INTEGER
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_session_hook_runs_session ON session_hook_runs(session_id)"
      );
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_permission_modes (
          session_id TEXT NOT NULL,
          ts         TEXT,
          mode       TEXT NOT NULL
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_session_permission_modes_session ON session_permission_modes(session_id)"
      );

      // Partial indexes: both columns are NULL on the large majority of
      // historical rows, so indexing only the non-NULL ones keeps these small
      // enough to be worth having.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_turns_effort ON turns(effort) WHERE effort IS NOT NULL"
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_turns_attribution_mcp_server ON turns(attribution_mcp_server) WHERE attribution_mcp_server IS NOT NULL"
      );
    },
  },
  {
    version: 21,
    name: "A2: per-turn one-shot task outcome for cross-tab analytics",
    up: (db) => {
      // "One-shot" is a property of a SEQUENCE (edit -> verify -> result), not
      // of a turn, so it cannot be recovered by a GROUP BY over `turns`. Until
      // now it existed only as the two session-level totals
      // (`sessions.verified_task_count` / `one_shot_task_count`), which can be
      // crossed with nothing finer than a whole session.
      //
      // This column records the outcome against the turn that STARTED each
      // task — the assistant turn carrying the Edit/Write — so any turn-level
      // dimension can be crossed with first-pass success by grouping on it.
      // A2 uses `effort`; A4 (attribution_skill) and A6 (denial_kind) join the
      // same column rather than each growing a rollup of their own.
      //
      // NULL is the overwhelming majority: it means "this turn did not start a
      // verified task", which covers every user turn, every assistant turn
      // without an edit, and every edit whose verification never ran. It does
      // NOT mean failure.
      const hasCol = (table: string, col: string) =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .some((c) => c.name === col);
      if (!hasCol("turns", "task_outcome")) {
        db.prepare("ALTER TABLE turns ADD COLUMN task_outcome TEXT").run();
      }
      // Partial: non-NULL on a small fraction of rows, which is exactly the
      // subset every query against this column wants.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_turns_task_outcome ON turns(task_outcome) WHERE task_outcome IS NOT NULL"
      );
    },
  },
  {
    version: 22,
    name: "A5: record which source produced each PR link",
    up: (db) => {
      // Minder learns about a session's PRs two ways, and they are not equally
      // trustworthy:
      //
      //   recorded — a `type:"pr-link"` entry Claude Code wrote itself. The URL,
      //              number and repository are reported, not parsed.
      //   scraped  — a GitHub PR URL pulled out of a `gh pr create` tool result
      //              by regex. Everything about it is inferred from command
      //              output, including the repo, which is recovered from the URL.
      //
      // Both stay (measured: the recorded entries alone would lose 5 real links
      // on this corpus). Recording WHICH produced a row keeps them from being
      // silently interchangeable — a scraped link can be a false positive in a
      // way a recorded one cannot, e.g. `gh pr create` replying "a pull request
      // already exists: <url>" reads exactly like a successful create.
      //
      // NULL means "written before this column existed", not "scraped". Existing
      // rows are deliberately NOT backfilled to `scraped`: most of them are in
      // fact recorded, and guessing would put a wrong provenance on 652 rows
      // that a re-parse then has to correct.
      //
      // The re-parse is driven by `DERIVED_VERSION` 15, NOT by this migration.
      // An earlier version of this comment claimed the rows would "re-populate
      // on the next reconcile like every other derived column"; they would not.
      // An unchanged transcript hits the no-op gate and is never re-read, and a
      // growing one takes the tail path, which never revisits PR entries in the
      // already-indexed prefix — so without the bump these rows stay NULL
      // forever (Codex review, #385).
      const hasCol = (table: string, col: string) =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .some((c) => c.name === col);
      if (!hasCol("session_prs", "source")) {
        db.prepare("ALTER TABLE session_prs ADD COLUMN source TEXT").run();
      }
    },
  },
  {
    version: 23,
    name: "A6: hook failures reported alongside hook runs",
    up: (db) => {
      // `hookErrors` is a sibling array of plain strings on the same system
      // entry as `hookInfos` — NOT a field inside each hook record. So a failure
      // cannot be attributed to a specific command, and adding an `error` column
      // to `session_hook_runs` would have meant guessing which of the entry's
      // hooks produced it. Its own table records what is actually known: when it
      // happened, what it said, and whether it stopped the turn.
      //
      // 185 non-empty `hookErrors` arrays on the local corpus, all advisory
      // (`preventedContinuation` was false on every one of 4,189 carriers). The
      // flag is stored anyway: "no blocking failure has happened yet" and "we
      // cannot see blocking failures" are different claims, and only the first
      // is true.
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_hook_errors (
          session_id             TEXT NOT NULL,
          ts                     TEXT,
          message                TEXT NOT NULL,
          prevented_continuation INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_session_hook_errors_session
          ON session_hook_errors(session_id);
      `);
    },
  },
  {
    version: 24,
    name: "C3: OTEL correlation key + tool provenance as real columns",
    up: (db) => {
      const hasCol = (table: string, col: string) =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .some((c) => c.name === col);

      // Both values already exist inside `payload_json`. Promoting them to
      // columns is not denormalisation for its own sake — `JSON_EXTRACT` cannot
      // use an index, so correlating by request id meant a full scan of a
      // 641k-row table per lookup. Measured while writing this: 300 such
      // lookups did not finish in ten minutes. As columns it is an index probe.
      //
      //   request_id  — the join key between OTEL and the transcript. Claude
      //                 Code writes it as `requestId` on assistant entries and
      //                 as `attrs.request_id` on `api_request` events. C3 was
      //                 specified against `message.uuid`, which does not appear
      //                 in this data under any spelling; `request_id` does, on
      //                 100% of both sides.
      //   tool_source — 'builtin' | 'mcp' (and presumably 'plugin', unobserved
      //                 locally). Tool provenance stated outright instead of
      //                 inferred from an `mcp__server__tool` name — the
      //                 OTEL-side twin of A4's attribution.
      if (!hasCol("otel_events", "request_id")) {
        db.prepare("ALTER TABLE otel_events ADD COLUMN request_id TEXT").run();
      }
      if (!hasCol("otel_events", "tool_source")) {
        db.prepare("ALTER TABLE otel_events ADD COLUMN tool_source TEXT").run();
      }
      // The other half of the join. Without a request id on `turns` the
      // correlation can only count distinct ids within OTEL, which answers
      // nothing — it would report 100% coverage by construction.
      if (!hasCol("turns", "request_id")) {
        db.prepare("ALTER TABLE turns ADD COLUMN request_id TEXT").run();
      }
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_turns_request_id ON turns(request_id) WHERE request_id IS NOT NULL"
      );

      // Backfill. OTEL events are append-only telemetry — nothing ever
      // re-ingests them — so without this the columns would only ever describe
      // events recorded after the upgrade, and every existing row would look
      // like it had no request id. That is the same "forward-only decode leaves
      // history blank" trap the A wave rejected.
      db.exec(`
        UPDATE otel_events
           SET request_id = JSON_EXTRACT(payload_json, '$.attrs.request_id')
         WHERE request_id IS NULL
           AND JSON_EXTRACT(payload_json, '$.attrs.request_id') IS NOT NULL;
        UPDATE otel_events
           SET tool_source = JSON_EXTRACT(payload_json, '$.attrs.tool_source')
         WHERE tool_source IS NULL
           AND JSON_EXTRACT(payload_json, '$.attrs.tool_source') IS NOT NULL;
      `);

      // Partial indexes: both columns are NULL on the majority of rows, and the
      // non-NULL subset is exactly what every query against them wants.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_otel_events_request_id
          ON otel_events(request_id) WHERE request_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_otel_events_tool_source
          ON otel_events(tool_source) WHERE tool_source IS NOT NULL;
      `);
    },
  },
  {
    version: 25,
    name: "#395: subagent tool calls, deduped by tool_use_id",
    up: (db) => {
      // Tool calls made *inside* subagent turns, one row per call.
      //
      // Keyed on `tool_use_id`, not aggregated into a per-tool counter, and
      // that is the whole point of the shape. A session is not always written
      // in one pass — `appendSessionTail` amends it as the file grows — and
      // dedupe state does not survive between parses. A counter therefore has
      // to be written additively, so a tool block re-logged across a window
      // boundary (83 re-logs in 37,394 blocks locally) is added a second time
      // and stays wrong until the next full re-parse. `INSERT OR IGNORE` on the
      // id is idempotent across windows, across the tail/full split, and across
      // repeated reconciles, with no state carried between them.
      //
      // Deliberately NOT rows in `tool_uses`. Sidechain turns have never carried
      // tool_uses rows, and ~20 queries across /usage, /agents, /skills, /costs
      // and the denial analytics read that table with no `is_sidechain`
      // predicate. Adding subagent rows there would move every one of those
      // numbers at once — the "quietly widening the existing meaning" that #395
      // explicitly rules out — and would leave twenty places that must each
      // remember to exclude them, which is precisely the one-contract-two-
      // implementations shape that produced #426.
      //
      // It survives a corpus this one does not have, too: on the local index no
      // session mixes primary and sidechain turns (0 of 6,045), because modern
      // Claude Code writes subagents to their own files. Older transcripts
      // inline them (`claudeConversations.ts:820` — probed 0/214 in 2026-05, but
      // that is a fact about this machine, not about the format). A separate
      // table is correct on both shapes; writing into `tool_uses` is only safe
      // on this one.
      //
      // `tool_name` as observed rather than a resolved spawn/search bucket, so
      // read-time keeps the interpretation — deciding later that WebFetch counts
      // toward the search cap then costs a query edit, not another
      // DERIVED_VERSION bump and a one-hour re-index.
      db.exec(`
        CREATE TABLE IF NOT EXISTS sidechain_tool_uses (
          session_id  TEXT NOT NULL,
          tool_use_id TEXT NOT NULL,
          tool_name   TEXT NOT NULL,
          PRIMARY KEY (session_id, tool_use_id),
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_sidechain_tool_uses_name
          ON sidechain_tool_uses(tool_name);
      `);

      // No backfill and no parent-session column. Parent linkage is derived from
      // `sessions.file_path` at read time instead of stamped here — a stored
      // column would be written by the same parse that stamps `derived_version`,
      // so an unrefreshed child would carry no link, and a roll-up looking for
      // children by that column would find none and report a root-only count as
      // a complete tree. The rows below are what the DERIVED_VERSION bump
      // re-derives; until a session reaches that version the roll-up reports
      // itself unmeasured rather than summing a partial tree.
    },
  },
  {
    // 27, NOT 26 — and the gap is deliberate. An earlier commit on this branch
    // shipped `version: 26` as a *different* migration ("credit an
    // already-populated index with a completed reconcile"), which was then
    // rejected as fabricated evidence and deleted. Any database that ran that
    // intermediate build is already stamped 26, so redefining 26 would never
    // run here: `aborted` would never be added, and every statement in
    // `indexerRuns.ts` that touches the column would throw into a deliberately
    // swallowed catch — a silent, permanent fail-open of the very gate this
    // migration exists to make trustworthy. Reusing a version number is only
    // ever safe when nothing has run the old one; that is not the case here.
    version: 27,
    name: "#470: indexer_runs.aborted — a finished run is not always a completed one",
    up: (db) => {
      // Readiness asked "is `finished_at_ms` set", which a THROWN pass and an
      // orphan closed by the next startup both satisfy — so a killed first
      // reconcile flipped the index to ready and the engagement report went
      // straight back to answering from a half-built index. Found independently
      // by Codex (P1) and Copilot on PR #471.
      //
      // A non-null `error` cannot carry this distinction on its own: it is also
      // set when a pass COMPLETED while individual files failed to parse, which
      // must still count as ready — one unparseable transcript cannot hold a
      // report offline indefinitely. Three states, so the boolean gets its own
      // column rather than being pattern-matched out of a human-readable string.
      //
      // Idempotent: fresh DBs already have it from schema.sql (v1).
      const cols = db.prepare("PRAGMA table_info(indexer_runs)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "aborted")) {
        db.exec("ALTER TABLE indexer_runs ADD COLUMN aborted INTEGER NOT NULL DEFAULT 0");
      }
      // Retract the withdrawn backfill. A DB that ran the intermediate v26
      // carries a row asserting a full pass that nobody observed; with
      // `aborted` now defaulting to 0 that row reads as completed and latches
      // readiness on exactly the partly-filled index the gate exists to catch.
      // Keyed on the marker string the withdrawn migration wrote, so it can
      // only ever match a row this project fabricated.
      db.prepare("DELETE FROM indexer_runs WHERE error = ?").run(
        "backfilled: index predates run tracking"
      );
    },
  },
  {
    version: 28,
    name: "home_properties: per-home filesystem case-sensitivity (#416)",
    up: (db) => {
      // A macOS volume is case-insensitive by default, so one project can be
      // recorded as both `-Users-me-Dev-app` and `-users-me-dev-app`. Both
      // produce a single slug through `toSlug`, but `queryByProject` keeps the
      // encoded dir name in its grouping identity and folds it only for
      // Windows-shaped (`X--`) encodings — so those two rows stay apart and the
      // project's cost splits across them. Same defect #236 fixed for Windows.
      //
      // The fix needs a fact the query layer does not have and CANNOT get: the
      // database stores an encoded path string, not the case-sensitivity of the
      // volume that produced it, and that volume may be on another machine or
      // since deleted. So it is recorded at ingest, where the filesystem is
      // actually reachable, and read back here.
      //
      // `case_sensitive` is nullable ON PURPOSE. NULL means "not determined" —
      // an empty home, an unreadable one, a volume that has gone away — and
      // reads as "do not fold", which is the current behaviour. Over-merging
      // silently sums two real projects into one number; under-merging shows
      // one project as two rows. Only the second is recoverable by looking.
      db.prepare(
        `CREATE TABLE IF NOT EXISTS home_properties (
           home_key       TEXT PRIMARY KEY,
           case_sensitive INTEGER,
           probed_at      TEXT NOT NULL
         )`
      ).run();
    },
  },
  {
    version: 29,
    name: "index sessions.derived_version so the mixed-derivation check is free (#478)",
    up: (db) => {
      // "Do the rows agree about which formula derived them" has to be asked
      // per request, and it has to be asked of the DATABASE — the reconcile
      // runs in a worker thread (`workers/ingestWorker.mjs`) whose `globalThis`
      // is isolated from the HTTP server's, so no in-process flag or memo can
      // carry the answer across (Codex P1, PR #525).
      //
      // Without an index, `SELECT DISTINCT derived_version ... LIMIT 2` scans
      // every row whenever the answer is "they agree" — the common case.
      // MEASURED on a copy of the reference index (6,944 sessions):
      //
      //   before   16.1 ms/call
      //   after     0.555 ms/call
      //
      // 29x, on a query that now runs per request. That cost is what drove
      // three failed attempts to cache the answer instead — a memo, then
      // boundary invalidation, then a live flag — each defeated by a different
      // window, and the last by process isolation.
      //
      // With the index it reads at most two keys. No cache, no window, nothing
      // to invalidate, and correct across processes because the evidence is the
      // shared file rather than either process's memory.
      db.prepare(
        "CREATE INDEX IF NOT EXISTS idx_sessions_derived_version ON sessions(derived_version)"
      ).run();
    },
  },
  {
    version: 30,
    name: "give sidechain_tool_uses enough to render a delegated timeline (#487)",
    up: (db) => {
      // The table was built to answer "how much tool work happened BELOW this
      // session" — a roll-up question, which needs only a name and an id. #487
      // gave it a second reader with a different question: a delegated agent's
      // own transcript now opens onto its own timeline, and a timeline needs
      // ORDER and ARGUMENTS. Without them a tool-heavy delegated session
      // rendered its prose and none of its actions, and a tool-only assistant
      // turn vanished entirely — while the file-parse backend, which reads the
      // JSONL directly, showed them. A backend divergence, not just a gap.
      // (Codex P1, PR #528.)
      //
      // Added here rather than by moving the rows into `tool_uses`: 23
      // `FROM tool_uses` sites across 11 modules read that table with no
      // sidechain predicate, so moving them shifts /usage, /agents, /skills,
      // /costs and the denial analytics at once. That move is #511's, made
      // deliberately and with its own review; this is the narrow half that
      // lets the page render.
      //
      // Every column is NULLABLE and there is no backfill. The rows that need
      // them are rewritten by the DERIVED_VERSION 22 -> 23 bump this change
      // already carries, and a row still carrying NULLs is a pre-#487 row whose
      // session has not been re-derived yet — which the reader treats as "no
      // ordering available" rather than "turn 0".
      // Asked, not attempted-and-caught. SQLite's ALTER TABLE has no
      // IF NOT EXISTS, and a blanket try/catch around it buys idempotence by
      // swallowing EVERY error — a read-only file, a full disk, corruption —
      // leaving the schema half-migrated with nothing reported. Reading
      // `PRAGMA table_info` first keeps the idempotence and lets a real failure
      // throw, which is the pattern the earlier migrations in this file use.
      // (Copilot, PR #528.)
      const existing = new Set(
        (
          db.prepare("PRAGMA table_info(sidechain_tool_uses)").all() as Array<{ name: string }>
        ).map((c) => c.name)
      );
      for (const [name, decl] of [
        ["turn_index", "INTEGER"],
        ["sequence_in_turn", "INTEGER"],
        ["ts", "TEXT"],
        ["agent_name", "TEXT"],
        ["skill_name", "TEXT"],
        ["arguments_json", "TEXT"],
        ["file_path", "TEXT"],
        ["file_op", "TEXT"],
      ] as const) {
        if (existing.has(name)) continue;
        db.prepare(`ALTER TABLE sidechain_tool_uses ADD COLUMN ${name} ${decl}`).run();
      }
    },
  },
];

/**
 * Highest migration this checkout knows how to apply — i.e. the schema version
 * a fully-migrated DB ends up at, and the version `sqlSchemaSnapshot.ts`
 * describes. Derived rather than written down so it cannot fall behind the
 * array it summarises.
 */
export const LATEST_MIGRATION_VERSION = MIGRATIONS.reduce(
  (max, m) => (m.version > max ? m.version : max),
  0
);

function resolveSchemaPath(): string {
  // Two lookups, and which one fires depends on how the app was built:
  //
  //   - `next dev` / `next start` from the repo: the compiled module sits next
  //     to `schema.sql`, so the sibling lookup wins;
  //   - the STANDALONE build: there is no `schema.sql` anywhere under `.next/`,
  //     so the sibling lookup misses and the walk below is what resolves —
  //     against `src/lib/db/schema.sql` in the payload, which gets there two
  //     ways: `outputFileTracingIncludes` in next.config.ts, and the explicit
  //     copy in `scripts/package-standalone.mjs` step 3b that exists for the
  //     worker bundle. (`src/lib/tasksDb/schema.sql` has only the former.)
  //
  // This comment previously said the sibling lookup was "what production and
  // the standalone build use" and called the walk dev/test-only. That was
  // backwards for the packaged artifact, and it is the kind of wrong that
  // costs someone a broken release: it reads as permission to drop `src/`
  // from the payload, which would break DB init on every install. (#284.)
  const sibling = path.join(__dirname, "schema.sql");
  if (existsSync(sibling)) return sibling;
  // turbopackIgnore: the walk is bounded (5 levels) but the tracer cannot
  // prove it. Without the ignore comment, Turbopack's file tracer can't
  // prove the loop is bounded and falls back to including every file
  // reachable from the project root in every route's output trace —
  // ballooning `.next/standalone` from a pruned few dozen MB to the
  // entire repo (src/, tests/, docs/, site/, etc.). See
  // https://nextjs.org/docs/messages/nft-unexpected-file-traced-in-nft-list
  //
  // Anchored to the server root (MINDER_SERVER_ROOT when the standalone
  // wrapper set it, else cwd) — see resolveServerRoot() for the full
  // rationale (PR #285 review, Codex P2 follow-up; same anchoring as
  // workerHost.ts's resolveDefaultWorkerEntry).
  let dir = resolveServerRoot();
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
/**
 * Lift `request_id` / `tool_source` out of `payload_json` for any OTEL rows
 * that arrived without them. Idempotent, incremental, and run on every startup.
 *
 * Migration v24 backfills these columns once, which is enough for the upgrade
 * it was written for and not enough in general: an older packaged Minder can
 * run against a database that has *already* reached v24 — the repo documents
 * that older trays do exactly this — and its four-column insert stays valid
 * while leaving both columns NULL. Coming back to a current build repairs
 * nothing, because `applyPendingMigrations` skips v24 once `schema_version` is
 * 24. The attributes are still sitting in `payload_json`, so the telemetry is
 * recoverable but permanently uncorrelated (Codex review, #387).
 *
 * A watermark keeps this cheap. `otel_events.id` is an INTEGER PRIMARY KEY, so
 * rows written during a downgrade sort above everything already lifted, and the
 * scan touches only what is new rather than re-JSON_EXTRACTing 641k rows on
 * every boot. The watermark is deliberately advanced to `MAX(id)` even when the
 * lift updated nothing: "examined" is the fact worth remembering, not "changed".
 */
export function liftOtelAttributeColumns(db: DatabaseT.Database): number {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='otel_events'")
    .get() as { name?: string } | undefined;
  if (!hasTable) return 0;

  const cols = db.prepare("PRAGMA table_info(otel_events)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "request_id")) return 0;

  const stored = db.prepare("SELECT value FROM meta WHERE key = 'otel_lift_watermark'").get() as
    | { value?: string }
    | undefined;
  const watermark = Number(stored?.value ?? 0) || 0;

  const max = (db.prepare("SELECT MAX(id) AS m FROM otel_events").get() as { m: number | null }).m;
  if (max === null || max <= watermark) return 0;

  const lift = db.transaction(() => {
    const a = db
      .prepare(
        `UPDATE otel_events
            SET request_id = JSON_EXTRACT(payload_json, '$.attrs.request_id')
          WHERE id > ? AND request_id IS NULL
            AND JSON_EXTRACT(payload_json, '$.attrs.request_id') IS NOT NULL`
      )
      .run(watermark).changes;
    const b = db
      .prepare(
        `UPDATE otel_events
            SET tool_source = JSON_EXTRACT(payload_json, '$.attrs.tool_source')
          WHERE id > ? AND tool_source IS NULL
            AND JSON_EXTRACT(payload_json, '$.attrs.tool_source') IS NOT NULL`
      )
      .run(watermark).changes;
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('otel_lift_watermark', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(String(max));
    return a + b;
  });

  return lift();
}

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

  // Drop the clean-shutdown marker up front, before the file it describes goes
  // anywhere. Doing it here rather than at the call sites covers all three
  // quarantine paths (open failed, quick_check failed, schema_version
  // unreadable) and both outcomes below (renamed aside, or deleted outright) —
  // clearing it at one call site left the other two able to leave a marker
  // behind that described a database no longer present.
  //
  // The size+mtime binding means a stale marker would almost certainly be
  // rejected anyway, so this is belt-and-braces rather than a live bug; the
  // reason to do it properly is that "almost certainly" is not a property worth
  // relying on when the consequence is skipping an integrity check.
  clearCleanShutdownMarker(DB_PATH);

  // Through the service log, so the event survives in `minder.log` with its
  // trigger (#560: two quarantined 1–2 GB indexes on this machine left no
  // trace beyond the file names, and a 30-minute rebuild each). `serviceLog`
  // forwards to the host when this runs on the ingest worker's `initDb`.
  const sizeBytes = dbFileSizeBytes();
  try {
    await renameWithRetry(DB_PATH, dest);
    await moveOrDeleteSiblings(dest);
    serviceLog({
      level: "error",
      subsystem: "db",
      msg: `quarantined corrupt index to ${dest}; will rebuild`,
      reason,
      dest,
      sizeBytes,
    });
    return dest;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null; // nothing to quarantine
    // Rename gave up after retries (still locked, or some other failure).
    // Fall back to outright delete so the rebuild can proceed.
    try {
      await fs.rm(DB_PATH, { force: true, maxRetries: 10, retryDelay: 100 });
      await moveOrDeleteSiblings(null);
      serviceLog({
        level: "error",
        subsystem: "db",
        msg:
          `could not preserve corrupt index (rename kept failing: ${(err as Error).message}); ` +
          `deleted instead so rebuild can proceed`,
        reason,
        sizeBytes,
      });
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
  /**
   * True when `PRAGMA quick_check` was skipped because the previous shutdown
   * was provably clean and the index is large enough for the scan to be
   * user-visible. Observability only — nothing branches on it; it exists so the
   * bootstrap log can distinguish "fast boot" from "check passed fast".
   *
   * Optional because results that never reached the check can't answer the
   * question: `synthFailureResult()` and the driver-missing path both
   * short-circuit before Path 2. `undefined` means "didn't get that far",
   * which is distinct from `false` ("ran it").
   */
  quickCheckSkipped?: boolean;
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
/**
 * Size of the main DB file in bytes, or 0 if it can't be stat'd. Feeding 0 into
 * `shouldRunQuickCheck` fails toward running the check, which is the safe
 * direction when we can't measure.
 */
function dbFileSizeBytes(): number {
  try {
    return statSync(DB_PATH).size;
  } catch {
    return 0;
  }
}

export async function initDb(): Promise<InitResult> {
  const result: InitResult = {
    available: false,
    appliedMigrations: [],
    schemaVersion: 0,
    quarantined: null,
    error: null,
    // Deliberately NOT initialized. The field is optional precisely so that
    // `undefined` means "never reached Path 2" (driver missing, open failed) —
    // seeding it to `false` would have every early return claim the check ran,
    // which is the opposite of the truth and makes the bootstrap log lie.
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

  // Path 2: quick_check, on every open EXCEPT a provably-clean restart of a
  // large index. quick_check is materially cheaper than integrity_check (skips
  // index/UNIQUE cross-checks) and catches the same corruption classes that
  // matter for a derived index — page-level damage and freelist breakage. We
  // can rebuild from the JSONLs anyway, so we don't need integrity_check's
  // index-level assurance on startup.
  //
  // It is, however, O(database size) and better-sqlite3 is synchronous, so on a
  // large index it blocks the event loop and the whole server is unreachable
  // until it finishes — measured at 2m47s on a 2.1 GB index.db from a cold page
  // cache, versus 74ms warm. `db/cleanShutdown.ts` documents the trust protocol
  // that lets us skip it after a graceful stop; anything short of proof (no
  // marker, changed file, non-empty WAL, forced via env) still runs it.
  const cleanState = readCleanShutdownState(DB_PATH);
  const runQuickCheck = shouldRunQuickCheck({
    cleanShutdown: cleanState.trusted,
    dbSizeBytes: dbFileSizeBytes(),
    force: quickCheckForced(),
  });
  // Recorded as soon as the decision is made, not after the check completes:
  // the quarantine-then-failed-reopen path below returns early, and setting
  // this at the end left it `undefined` there — reporting "never reached
  // Path 2" about a run that had just executed Path 2 and quarantined a
  // database. The field describes the decision, so it belongs with it.
  result.quickCheckSkipped = !runQuickCheck;

  if (runQuickCheck) {
    const integrity = db.prepare("PRAGMA quick_check").get() as {
      quick_check?: string;
    };
    if (integrity.quick_check !== "ok") {
      closeDb();
      // The marker is cleared inside quarantineCorruptDb, which covers every
      // quarantine path rather than just this one.
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
  }

  try {
    const { applied, current } = applyPendingMigrations(db);
    result.available = true;
    result.appliedMigrations = applied;
    result.schemaVersion = current;
    // After migrations, never inside one: this repairs rows a *downgrade* wrote,
    // which by definition appear when no migration is pending.
    liftOtelAttributeColumns(db);
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
