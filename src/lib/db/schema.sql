-- Project Minder local index — SQLite schema, version 1.
--
-- Design tenets:
--
-- * **The DB is a derived index.** Every row is reconstructible from the
--   filesystem (`~/.claude/projects/*.jsonl`, agent/skill catalog dirs,
--   `.minder.json`). On corruption we rename the file aside and rebuild —
--   no migrations need to handle ad-hoc data loss.
--
-- * **Migrations are additive-only.** Adding columns and tables is cheap;
--   changing a primary key or column type is expensive. We pay attention
--   here and avoid it later. `meta.schema_version` is bumped per migration.
--
-- * **Business logic runs at write time.** Cost, classification, one-shot
--   detection, cache hit ratios, etc. are computed when a turn is parsed
--   and stored as columns. Read-side queries are simple aggregates.
--
-- * **Versioned derivations.** Anything computed from code (cost rules,
--   classification regexes) carries a `*_version` integer. When the code
--   bumps its version, the indexer re-derives only rows whose stamp is
--   stale, not the whole corpus. Without this, every classifier tweak
--   would invalidate the entire index. The re-derive query is a full
--   scan of the affected table — there's no partial index. Acceptable
--   because re-derives only happen on code-version bumps (rare).
--
-- * **`byte_offset` is the resume cursor.** Every session row tracks how
--   far into its JSONL we've parsed. On change, we open the file, seek to
--   the offset, parse only new lines. 50 MB session-in-progress logs
--   become cheap because we never re-read the prefix.
--
-- * **FTS5 triggers, not ingest discipline.** prompts_fts and catalog_fts
--   are kept in sync via INSERT/UPDATE/DELETE triggers on the source
--   tables. The indexer doesn't need to remember to write FTS rows;
--   it's a schema-level invariant.

-- ─── meta ──────────────────────────────────────────────────────────────────
-- Version stamps and one-row settings. Always exactly one row per key.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- ─── sessions ────────────────────────────────────────────────────────────
-- One row per JSONL file. `byte_offset` is the resume cursor.
-- All "summary" columns are derived from the underlying turns.
-- `derived_version` lets us re-derive when business logic ships an update.

CREATE TABLE sessions (
  session_id            TEXT PRIMARY KEY,
  project_slug          TEXT,
  project_dir_name      TEXT NOT NULL,
  file_path             TEXT NOT NULL UNIQUE,
  file_mtime_ms         INTEGER NOT NULL,
  file_size             INTEGER NOT NULL,
  byte_offset           INTEGER NOT NULL DEFAULT 0,
  start_ts              TEXT,
  end_ts                TEXT,
  primary_model         TEXT,
  status                TEXT CHECK (status IN ('active','inactive','errored','approval','working','waiting','other')),
  outcome               TEXT CHECK (outcome IN ('success','gave_up','in_progress','errored')),
  turn_count            INTEGER NOT NULL DEFAULT 0,
  user_turn_count       INTEGER NOT NULL DEFAULT 0,
  assistant_turn_count  INTEGER NOT NULL DEFAULT 0,
  tool_call_count       INTEGER NOT NULL DEFAULT 0,
  error_count           INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL    NOT NULL DEFAULT 0,
  cache_hit_ratio       REAL,
  max_context_fill      REAL,
  has_compaction_loop   INTEGER NOT NULL DEFAULT 0 CHECK (has_compaction_loop IN (0,1)),
  has_tool_failure_streak INTEGER NOT NULL DEFAULT 0 CHECK (has_tool_failure_streak IN (0,1)),
  has_one_shot          INTEGER NOT NULL DEFAULT 0 CHECK (has_one_shot IN (0,1)),
  -- Per-session one-shot counts (sums of detectOneShot's totalVerifiedTasks
  -- and oneShotTasks). Stored so that aggregate queries over a period are a
  -- direct SUM(...) instead of rehydrating every turn through detectOneShot's
  -- window scan. has_one_shot is the binary "did this session have any?";
  -- these are the precise numerator/denominator for the rate.
  verified_task_count   INTEGER NOT NULL DEFAULT 0,
  one_shot_task_count   INTEGER NOT NULL DEFAULT 0,
  git_branch            TEXT,
  initial_prompt        TEXT,
  last_prompt           TEXT,
  derived_version       INTEGER NOT NULL DEFAULT 0,
  indexed_at_ms         INTEGER NOT NULL
);

CREATE INDEX sessions_by_project_end ON sessions(project_slug, end_ts DESC);
CREATE INDEX sessions_by_end_ts      ON sessions(end_ts DESC);
CREATE INDEX sessions_by_mtime       ON sessions(file_mtime_ms DESC);

-- ─── turns ───────────────────────────────────────────────────────────────
-- One row per assistant or user turn. `text_offset` points back into the
-- JSONL so a session-detail view can stream specific turns without
-- re-parsing the whole file. `text_preview` is the first ~500 chars
-- captured at ingest for quick display in lists.

CREATE TABLE turns (
  session_id           TEXT NOT NULL,
  turn_index           INTEGER NOT NULL,
  ts                   TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('user','assistant')),
  model                TEXT,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
  context_fill         REAL,
  is_error             INTEGER NOT NULL DEFAULT 0 CHECK (is_error IN (0,1)),
  parent_tool_use_id   TEXT,
  text_offset          INTEGER,
  text_preview         TEXT,
  -- Per-turn dollar cost, derived at ingest from `applyPricing`. The session
  -- row's `cost_usd` is SUM(this) over assistant turns. Storing per-turn
  -- lets every "by X" aggregate (`byModel`, `byProject`, `byCategory`,
  -- `daily`) be a single SQL `SUM(cost_usd) GROUP BY ...` instead of
  -- rehydrating turns and re-running JS pricing. Default 0 covers user
  -- turns and synthetic-model assistant turns naturally.
  cost_usd             REAL    NOT NULL DEFAULT 0,
  -- For user turns that carry a tool_result, the truncated result text
  -- (~2000 chars). Stored separately from `text_preview` so that
  -- `detectOneShot`'s error-pattern check can survive a rehydrate-from-DB
  -- round-trip after a tail-append; otherwise prior failed verifications
  -- would be invisible and one-shot stats would drift on tail.
  tool_result_preview  TEXT,
  category             TEXT,
  -- Same `derived_version` semantics as on sessions/agents/skills/commands:
  -- bump the code's version constant to invalidate just this column's
  -- derivation. Named identically across tables on purpose.
  derived_version      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, turn_index),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX turns_by_role_ts  ON turns(role, ts);
CREATE INDEX turns_by_category ON turns(category) WHERE category IS NOT NULL;

-- ─── tool_uses ───────────────────────────────────────────────────────────
-- One row per tool call inside a turn. `sequence_in_turn` is a 0-indexed
-- counter assigned at ingest — it makes the PK trivially unique even when
-- two tool calls in the same turn lack a `tool_use_id` (older JSONL).
-- Using COALESCE(tool_use_id, '') instead would collide for those rows.

CREATE TABLE tool_uses (
  session_id        TEXT NOT NULL,
  turn_index        INTEGER NOT NULL,
  sequence_in_turn  INTEGER NOT NULL,
  tool_use_id       TEXT,
  ts                TEXT,
  tool_name         TEXT NOT NULL,
  mcp_server        TEXT,
  mcp_tool          TEXT,
  agent_name        TEXT,
  skill_name        TEXT,
  arguments_json    TEXT,
  file_path         TEXT,
  file_op           TEXT CHECK (file_op IN ('read','write','edit','delete')),
  duration_ms       INTEGER,
  is_error          INTEGER NOT NULL DEFAULT 0 CHECK (is_error IN (0,1)),
  PRIMARY KEY (session_id, turn_index, sequence_in_turn),
  FOREIGN KEY (session_id, turn_index) REFERENCES turns(session_id, turn_index) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX tool_uses_by_name_ts ON tool_uses(tool_name, ts);
CREATE INDEX tool_uses_by_file    ON tool_uses(file_path) WHERE file_path IS NOT NULL;
CREATE INDEX tool_uses_by_agent   ON tool_uses(agent_name) WHERE agent_name IS NOT NULL;
CREATE INDEX tool_uses_by_skill   ON tool_uses(skill_name) WHERE skill_name IS NOT NULL;
CREATE INDEX tool_uses_by_mcp     ON tool_uses(mcp_server) WHERE mcp_server IS NOT NULL;

-- ─── file_edits ──────────────────────────────────────────────────────────
-- Denormalized "this turn produced a write/edit on this file" projection.
-- Drives the hot-file detector and file-coupling diagrams from the TODO.
-- One row per (turn, file) — multiple edits to the same file in one turn
-- collapse to a single row.

CREATE TABLE file_edits (
  session_id   TEXT NOT NULL,
  turn_index   INTEGER NOT NULL,
  file_path    TEXT NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('write','edit','delete')),
  ts           TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_index, file_path),
  FOREIGN KEY (session_id, turn_index) REFERENCES turns(session_id, turn_index) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX file_edits_by_path ON file_edits(file_path, ts DESC);

-- ─── daily_costs ─────────────────────────────────────────────────────────
-- Pre-aggregated rollup by (day, project, model). Updated incrementally on
-- every session ingest via INSERT … ON CONFLICT DO UPDATE so the /usage
-- chart is a direct read, not a runtime aggregation.

CREATE TABLE daily_costs (
  day                  TEXT NOT NULL,
  project_slug         TEXT NOT NULL,
  model                TEXT NOT NULL,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_usd             REAL    NOT NULL DEFAULT 0,
  turn_count           INTEGER NOT NULL DEFAULT 0,
  session_count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, project_slug, model)
) WITHOUT ROWID;

CREATE INDEX daily_costs_by_day ON daily_costs(day DESC);

-- ─── category_costs ─────────────────────────────────────────────────────
-- Pre-aggregated rollup by (day, project, category). Sister table to
-- `daily_costs`, but keyed on the classifier's category instead of model.
-- Drives `byCategory` on /api/usage as a direct SELECT — no rehydrate,
-- no in-JS classification pass. Updated incrementally by the ingest
-- pipeline whenever a session's turns change category mix (e.g., a
-- classifier version bump moves a turn from 'Coding' to 'Refactoring').
--
-- Note: `byCategory.oneShotRate` is intentionally NOT denormalized here.
-- The rate is per-(category, session) and would need a much wider
-- pre-aggregate to maintain. The SQL read-path leaves the field
-- undefined; consumers that need it fall back to the file-parse backend.

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

-- ─── catalogs (agents / skills / commands) ────────────────────────────────
-- One row per catalog entry. `source` is 'user' | 'plugin' | 'project'.
-- `body_excerpt` holds the first ~2 KB; full bodies stay in the source
-- file and are read on demand. `file_mtime_ms + file_size` lets the
-- indexer skip unchanged entries on re-walk.

CREATE TABLE agents (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('user','plugin','project')),
  project_slug      TEXT,
  plugin_name       TEXT,
  description       TEXT,
  category          TEXT,
  model             TEXT,
  tools_json        TEXT,
  body_excerpt      TEXT,
  body_path         TEXT NOT NULL,
  file_mtime_ms     INTEGER NOT NULL,
  file_size         INTEGER NOT NULL,
  provenance_json   TEXT,
  derived_version   INTEGER NOT NULL DEFAULT 0,
  indexed_at_ms     INTEGER NOT NULL
);

CREATE INDEX agents_by_source ON agents(source);
CREATE INDEX agents_by_name   ON agents(name);

CREATE TABLE skills (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('user','plugin','project')),
  project_slug      TEXT,
  plugin_name       TEXT,
  description       TEXT,
  layout            TEXT CHECK (layout IN ('bundled','standalone')),
  user_invocable    INTEGER NOT NULL DEFAULT 0 CHECK (user_invocable IN (0,1)),
  argument_hint     TEXT,
  version           TEXT,
  body_excerpt      TEXT,
  body_path         TEXT NOT NULL,
  file_mtime_ms     INTEGER NOT NULL,
  file_size         INTEGER NOT NULL,
  provenance_json   TEXT,
  derived_version   INTEGER NOT NULL DEFAULT 0,
  indexed_at_ms     INTEGER NOT NULL
);

CREATE INDEX skills_by_source ON skills(source);
CREATE INDEX skills_by_name   ON skills(name);

CREATE TABLE commands (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('user','plugin','project')),
  project_slug      TEXT,
  plugin_name       TEXT,
  description       TEXT,
  argument_hint     TEXT,
  body_excerpt      TEXT,
  body_path         TEXT NOT NULL,
  file_mtime_ms     INTEGER NOT NULL,
  file_size         INTEGER NOT NULL,
  derived_version   INTEGER NOT NULL DEFAULT 0,
  indexed_at_ms     INTEGER NOT NULL
);

CREATE INDEX commands_by_source ON commands(source);

-- ─── mcp_servers ─────────────────────────────────────────────────────────
-- `id` construction rule: for user-scope servers it's `user:<name>`; for
-- project-scope it's `<project_slug>:<name>`. This keeps two projects'
-- "postgres" servers as distinct rows even when their configs match.
--
-- `description_hash` is the SHA-256 of the server's announced tool
-- descriptions at scan time. The "MCP rug-pull detector" TODO compares
-- the current hash to the previous; a change without a version bump is
-- the warning condition.

CREATE TABLE mcp_servers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  -- 'plugin' is intentionally absent: MCP servers register at user or
  -- project scope only. Plugin-bundled MCP servers surface as user-scope
  -- after the plugin is enabled, so they collapse into 'user'.
  source            TEXT NOT NULL CHECK (source IN ('user','project')),
  project_slug      TEXT,
  command           TEXT,
  args_json         TEXT,
  env_json          TEXT,
  description_hash  TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  indexed_at_ms     INTEGER NOT NULL
);

-- ─── otel_events ─────────────────────────────────────────────────────────
-- Thin telemetry events ingested from Claude Code's OTEL pipeline. Schema
-- stays generic (`payload_json`) so we can add detectors without migrating
-- every event row. Detectors that need fast filters denormalize the
-- relevant fields into top-level columns later.

CREATE TABLE otel_events (
  id            INTEGER PRIMARY KEY,
  ts            TEXT NOT NULL,
  session_id    TEXT,
  event_name    TEXT NOT NULL,
  payload_json  TEXT NOT NULL
);

CREATE INDEX otel_events_by_session ON otel_events(session_id, ts);
CREATE INDEX otel_events_by_name_ts ON otel_events(event_name, ts);

-- ─── indexer_runs ─────────────────────────────────────────────────────────
-- Heartbeat / audit trail for the indexer worker. Lets the read-side
-- answer "is the indexer alive? when did it last run? what failed?"
-- without reading log files. Bounded retention enforced by the indexer
-- (keep last 100 runs).

CREATE TABLE indexer_runs (
  id            INTEGER PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  kind          TEXT NOT NULL CHECK (kind IN ('reconcile','incremental','rebuild')),
  files_seen    INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  rows_written  INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);

CREATE INDEX indexer_runs_by_started ON indexer_runs(started_at_ms DESC);

-- ─── full-text search ─────────────────────────────────────────────────────
-- FTS5 virtual tables shadow the source tables. `text` is the indexed
-- column; everything else is `UNINDEXED` so we can SELECT it without
-- paying the FTS retrieval cost. Tokenizer choice: `porter unicode61`
-- gives us folded case + stemming for English without hand-tuning.

CREATE VIRTUAL TABLE prompts_fts USING fts5(
  session_id   UNINDEXED,
  turn_index   UNINDEXED,
  role         UNINDEXED,
  ts           UNINDEXED,
  text,
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE catalog_fts USING fts5(
  kind         UNINDEXED,
  id           UNINDEXED,
  name,
  description,
  text,
  tokenize='porter unicode61'
);

-- ─── FTS5 sync triggers ───────────────────────────────────────────────────
-- These keep the FTS tables in lockstep with their source tables without
-- the indexer having to remember. Each trigger maps an INSERT/UPDATE/DELETE
-- on the source to the matching FTS row.
--
-- prompts_fts mirrors `turns.text_preview` (first ~500 chars). For full-body
-- search we'd need to also stream JSONL content into FTS — explicitly
-- deferred to keep DB size bounded. The preview covers prompt-text search,
-- which is the primary use case.
--
-- Why DELETE+INSERT rather than UPDATE on the FTS row? FTS5 with UNINDEXED
-- columns doesn't support partial UPDATE cleanly — the recommended pattern
-- is delete-then-reinsert. See https://sqlite.org/fts5.html.
--
-- Known cost concern (TODO P2a-2): the DELETE WHERE session_id=? AND
-- turn_index=? filters on UNINDEXED FTS columns, so each delete forces a
-- scan over prompts_fts. For one-off updates this is fine; for a cascaded
-- delete of a session with thousands of turns it's O(turns × fts_rows).
-- The fix is to give turns an integer FTS rowid alias and delete by it
-- (FTS5 external-content pattern). Deferred until P2a-2 ingest lets us
-- measure the actual delete cost on a populated index.

CREATE TRIGGER turns_ai AFTER INSERT ON turns
BEGIN
  INSERT INTO prompts_fts (session_id, turn_index, role, ts, text)
  VALUES (NEW.session_id, NEW.turn_index, NEW.role, NEW.ts, COALESCE(NEW.text_preview, ''));
END;

-- Narrow the trigger to only the columns mirrored into FTS. A re-derive
-- UPDATE that only touches `category` / `derived_version` / token counts
-- doesn't fire this trigger at all. `AFTER UPDATE OF <columns>` is
-- evaluated by SQLite at the statement level, cheaper than a per-row
-- WHEN clause.
CREATE TRIGGER turns_au AFTER UPDATE OF text_preview, role, ts ON turns
BEGIN
  DELETE FROM prompts_fts WHERE session_id = OLD.session_id AND turn_index = OLD.turn_index;
  INSERT INTO prompts_fts (session_id, turn_index, role, ts, text)
  VALUES (NEW.session_id, NEW.turn_index, NEW.role, NEW.ts, COALESCE(NEW.text_preview, ''));
END;

CREATE TRIGGER turns_ad AFTER DELETE ON turns
BEGIN
  DELETE FROM prompts_fts WHERE session_id = OLD.session_id AND turn_index = OLD.turn_index;
END;

-- catalog_fts is a union view over agents/skills/commands; one trigger set
-- per source table writes/updates/deletes the matching `kind` row.

CREATE TRIGGER agents_ai AFTER INSERT ON agents
BEGIN
  INSERT INTO catalog_fts (kind, id, name, description, text)
  VALUES ('agent', NEW.id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.body_excerpt, ''));
END;

-- Narrow to FTS-mirrored columns: `derived_version`, `indexed_at_ms`,
-- `file_mtime_ms`, etc. update routinely without changing search content.
CREATE TRIGGER agents_au AFTER UPDATE OF name, description, body_excerpt ON agents
BEGIN
  DELETE FROM catalog_fts WHERE kind = 'agent' AND id = OLD.id;
  INSERT INTO catalog_fts (kind, id, name, description, text)
  VALUES ('agent', NEW.id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.body_excerpt, ''));
END;

CREATE TRIGGER agents_ad AFTER DELETE ON agents
BEGIN
  DELETE FROM catalog_fts WHERE kind = 'agent' AND id = OLD.id;
END;

CREATE TRIGGER skills_ai AFTER INSERT ON skills
BEGIN
  INSERT INTO catalog_fts (kind, id, name, description, text)
  VALUES ('skill', NEW.id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.body_excerpt, ''));
END;

CREATE TRIGGER skills_au AFTER UPDATE OF name, description, body_excerpt ON skills
BEGIN
  DELETE FROM catalog_fts WHERE kind = 'skill' AND id = OLD.id;
  INSERT INTO catalog_fts (kind, id, name, description, text)
  VALUES ('skill', NEW.id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.body_excerpt, ''));
END;

CREATE TRIGGER skills_ad AFTER DELETE ON skills
BEGIN
  DELETE FROM catalog_fts WHERE kind = 'skill' AND id = OLD.id;
END;

CREATE TRIGGER commands_ai AFTER INSERT ON commands
BEGIN
  INSERT INTO catalog_fts (kind, id, name, description, text)
  VALUES ('command', NEW.id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.body_excerpt, ''));
END;

CREATE TRIGGER commands_au AFTER UPDATE OF name, description, body_excerpt ON commands
BEGIN
  DELETE FROM catalog_fts WHERE kind = 'command' AND id = OLD.id;
  INSERT INTO catalog_fts (kind, id, name, description, text)
  VALUES ('command', NEW.id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.body_excerpt, ''));
END;

CREATE TRIGGER commands_ad AFTER DELETE ON commands
BEGIN
  DELETE FROM catalog_fts WHERE kind = 'command' AND id = OLD.id;
END;
