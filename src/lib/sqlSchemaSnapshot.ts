// Last verified: schema version 14 (src/lib/db/schema.sql + migrations v1-v14)
// Re-verify with `tests/sqlSchemaSnapshot.test.ts` after any migration.

export interface TableSchema {
  table: string;
  columns: string[];
  /** FTS5 virtual tables — PRAGMA table_info behaves differently for these. */
  virtual?: true;
}

export const SQL_SCHEMA: TableSchema[] = [
  {
    table: "meta",
    columns: ["key", "value"],
  },
  {
    table: "sessions",
    columns: [
      "session_id", "project_slug", "project_dir_name", "file_path",
      "file_mtime_ms", "file_size", "byte_offset", "start_ts", "end_ts",
      "primary_model", "status", "outcome", "turn_count", "user_turn_count",
      "assistant_turn_count", "tool_call_count", "error_count", "input_tokens",
      "output_tokens", "cache_create_tokens", "cache_read_tokens", "cost_usd",
      "cache_hit_ratio", "max_context_fill", "has_compaction_loop",
      "has_tool_failure_streak", "has_one_shot", "verified_task_count",
      "one_shot_task_count", "git_branch", "initial_prompt", "last_prompt",
      "slug", "continued_from_session_id", "has_thinking", "cli_version",
      "has_resume_anomaly", "compact_boundary_count", "derived_version",
      "indexed_at_ms", "generated_title", "starred_at", "distilled_at",
      "distilled_text",
      "work_mode_exploration_pct", "work_mode_building_pct",
      "work_mode_testing_pct", "work_mode_other_pct",
      "source",
    ],
  },
  {
    table: "turns",
    columns: [
      "session_id", "turn_index", "ts", "role", "model", "input_tokens",
      "output_tokens", "cache_create_tokens", "cache_read_tokens", "context_fill",
      "is_error", "parent_tool_use_id", "text_offset", "text_preview", "cost_usd",
      "tool_result_preview", "category", "turn_duration_ms", "has_thinking",
      "derived_version", "is_sidechain",
    ],
  },
  {
    table: "tool_uses",
    columns: [
      "session_id", "turn_index", "sequence_in_turn", "tool_use_id", "ts",
      "tool_name", "mcp_server", "mcp_tool", "agent_name", "skill_name",
      "arguments_json", "file_path", "file_op", "duration_ms", "is_error",
      "error_category", "invocation_source",
    ],
  },
  {
    table: "file_edits",
    columns: ["session_id", "turn_index", "file_path", "op", "ts"],
  },
  {
    table: "daily_costs",
    columns: [
      "day", "project_slug", "model", "input_tokens", "output_tokens",
      "cache_create_tokens", "cache_read_tokens", "cost_usd", "turn_count",
      "session_count",
    ],
  },
  {
    table: "category_costs",
    columns: ["day", "project_slug", "category", "turns", "tokens", "cost_usd"],
  },
  {
    table: "agents",
    columns: [
      "id", "name", "source", "project_slug", "plugin_name", "description",
      "category", "model", "tools_json", "body_excerpt", "body_path",
      "file_mtime_ms", "file_size", "provenance_json", "derived_version",
      "indexed_at_ms",
    ],
  },
  {
    table: "skills",
    columns: [
      "id", "name", "source", "project_slug", "plugin_name", "description",
      "layout", "user_invocable", "argument_hint", "version", "body_excerpt",
      "body_path", "file_mtime_ms", "file_size", "provenance_json",
      "derived_version", "indexed_at_ms",
    ],
  },
  {
    table: "commands",
    columns: [
      "id", "name", "source", "project_slug", "plugin_name", "description",
      "argument_hint", "body_excerpt", "body_path", "file_mtime_ms", "file_size",
      "derived_version", "indexed_at_ms",
    ],
  },
  {
    table: "mcp_servers",
    columns: [
      "id", "name", "source", "project_slug", "command", "args_json", "env_json",
      "description_hash", "enabled", "indexed_at_ms",
    ],
  },
  {
    table: "otel_events",
    columns: ["id", "ts", "session_id", "event_name", "payload_json"],
  },
  {
    table: "indexer_runs",
    columns: [
      "id", "started_at_ms", "finished_at_ms", "kind", "files_seen",
      "files_changed", "rows_written", "error",
    ],
  },
  {
    table: "session_prs",
    columns: ["session_id", "pr_url", "pr_number", "repo"],
  },
  {
    table: "session_tickets",
    columns: ["session_id", "url", "provider", "ticket_key"],
  },
  {
    table: "prompts_fts",
    columns: ["session_id", "turn_index", "role", "ts", "text"],
    virtual: true,
  },
  {
    table: "catalog_fts",
    columns: ["kind", "id", "name", "description", "text"],
    virtual: true,
  },
];
