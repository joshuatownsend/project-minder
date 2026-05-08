-- ~/.minder/tasks.db schema v1 (Wave 9.1a — Mission Control foundation)
--
-- Tenets:
-- * This DB is tool-managed state (not user config). Rebuild from task
--   definitions if corrupted; COW backup via configHistory is not needed.
-- * Status enum is locked: pending / awaiting_approval / running / done /
--   failed / cancelled. Matches the brainstorming spec line 154 verbatim.
-- * All timestamps are TEXT ISO 8601 with 'Z' suffix for UTC consistency.
-- * schedule_id FK included now so /api/schedules/[id]/runs can backlink
--   schedule → tasks in Wave 9.1b.
-- * PRAGMA foreign_keys is set by connection.ts at open time, not here.
--

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Recurring schedule templates. Each enabled schedule materializes a new
-- ops_tasks row on every cron tick (done by the dispatcher in Wave 9.1b).
CREATE TABLE IF NOT EXISTS ops_schedules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  cron_expression  TEXT    NOT NULL,
  task_title       TEXT    NOT NULL,
  task_description TEXT    NOT NULL DEFAULT '',
  assigned_skill   TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_run_at      TEXT,
  last_run_at      TEXT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Supports dispatcher's "SELECT WHERE enabled=1 AND next_run_at <= ?" query.
CREATE INDEX IF NOT EXISTS ix_schedules_active
  ON ops_schedules(enabled, next_run_at) WHERE enabled = 1;

-- Individual task rows. One row per unit of work to dispatch.
CREATE TABLE IF NOT EXISTS ops_tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  title               TEXT    NOT NULL,
  description         TEXT    NOT NULL DEFAULT '',
  status              TEXT    NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','awaiting_approval','running','done','failed','cancelled')),
  priority            INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  quadrant            TEXT    NOT NULL DEFAULT 'do'
    CHECK (quadrant IN ('do','schedule','delegate','archive')),
  assigned_skill      TEXT,
  model               TEXT,
  execution_mode      TEXT    NOT NULL DEFAULT 'stream'
    CHECK (execution_mode IN ('classic','stream')),
  scheduled_for       TEXT,
  requires_approval   INTEGER NOT NULL DEFAULT 0 CHECK (requires_approval IN (0, 1)),
  risk_level          TEXT    NOT NULL DEFAULT 'low'
    CHECK (risk_level IN ('low','medium','high')),
  dry_run             INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1)),
  schedule_id         INTEGER REFERENCES ops_schedules(id) ON DELETE SET NULL,
  approved_at         TEXT,
  -- session_id is populated by the dispatcher's stream-mode init event (Wave 9.1b).
  session_id          TEXT,
  started_at          TEXT,
  completed_at        TEXT,
  duration_ms         INTEGER,
  cost_usd            REAL,
  output_summary      TEXT,
  error_message       TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS ix_tasks_status
  ON ops_tasks(status);
CREATE INDEX IF NOT EXISTS ix_tasks_quadrant
  ON ops_tasks(quadrant);
CREATE INDEX IF NOT EXISTS ix_tasks_scheduled
  ON ops_tasks(scheduled_for) WHERE scheduled_for IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_tasks_schedule_fk
  ON ops_tasks(schedule_id) WHERE schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_tasks_session
  ON ops_tasks(session_id) WHERE session_id IS NOT NULL;
