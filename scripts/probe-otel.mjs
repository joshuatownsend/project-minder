/**
 * Phase 0 verification script for Wave 8.1b.
 *
 * Opens ~/.minder/index.db read-only and prints, for each distinct
 * event_name and metric_name:
 *   - Row count
 *   - Set of attribute keys observed across the first 100 rows
 *   - One example payload/data-point pretty-printed
 *
 * Run after installing OTEL via Settings → Integrations → OTEL and
 * restarting Claude Code, then exercising Edit/Write/Read/Bash/mcp__ tools.
 *
 * Usage:
 *   node scripts/probe-otel.mjs
 */

import { createRequire } from "module";
import os from "os";
import path from "path";
import { existsSync, readFileSync } from "fs";

const require = createRequire(import.meta.url);

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  console.error("better-sqlite3 not available — run from C:\\dev\\project-minder with node installed.");
  process.exit(1);
}

const DB_PATH = path.join(os.homedir(), ".minder", "index.db");

let db;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch (err) {
  console.error(`Could not open DB at ${DB_PATH}: ${err.message}`);
  console.error("Make sure Project Minder has run at least once (pnpm dev) to create the DB.");
  process.exit(1);
}

function hr(char = "─", width = 72) {
  return char.repeat(width);
}

function printSection(title) {
  console.log("\n" + hr("═"));
  console.log(`  ${title}`);
  console.log(hr("═"));
}

function printSubsection(title) {
  console.log("\n" + hr("─"));
  console.log(`  ${title}`);
  console.log(hr("─"));
}

// ── Request log (diagnostic) ─────────────────────────────────────────────────

const OTEL_LOG = path.join(os.homedir(), ".minder", "otel-requests.log");
printSection("Request log (~/.minder/otel-requests.log)");
if (!existsSync(OTEL_LOG)) {
  console.log("\n⚠  No request log found — Project Minder has never received an OTEL POST.");
  console.log("   This file is created the first time /api/otel/v1/logs is called.");
} else {
  const lines = readFileSync(OTEL_LOG, "utf-8").trim().split("\n").filter(Boolean);
  console.log(`\n${lines.length} request(s) received since log creation.`);
  console.log("Last 5:");
  lines.slice(-5).forEach(l => console.log(" ", l));
}

// ── otel_events ──────────────────────────────────────────────────────────────

printSection("otel_events");

const totalEvents = db.prepare("SELECT COUNT(*) AS c FROM otel_events").get().c;
console.log(`\nTotal rows: ${totalEvents}`);

if (totalEvents === 0) {
  console.log("\n⚠  No OTEL log events in the database yet.");
  console.log("   Steps to generate data:");
  console.log("   1. Settings → Integrations → OTEL → Install");
  console.log("   2. Verify ~/.claude/settings.json has CLAUDE_CODE_ENABLE_TELEMETRY=1 etc.");
  console.log("   3. Fully restart Claude Code (env vars are read once at startup).");
  console.log("   4. Run a Claude Code session that uses Edit/Write/Read/Bash/mcp__ tools.");
  console.log("   5. Accept and reject at least 3 Edit or Write proposals.");
  console.log("   6. Re-run this script.");
} else {
  const eventNames = db
    .prepare("SELECT DISTINCT event_name, COUNT(*) AS c FROM otel_events GROUP BY event_name ORDER BY c DESC")
    .all();

  console.log("\nEvent names and counts:");
  for (const row of eventNames) {
    console.log(`  ${row.event_name.padEnd(36)} ${String(row.c).padStart(6)} rows`);
  }

  for (const { event_name } of eventNames) {
    printSubsection(`event_name = "${event_name}"`);

    const samples = db
      .prepare("SELECT payload_json FROM otel_events WHERE event_name = ? LIMIT 100")
      .all(event_name);

    const attrKeys = new Set();
    const topLevelKeys = new Set();
    let examplePayload = null;

    for (const row of samples) {
      let payload;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      if (!examplePayload) examplePayload = payload;

      Object.keys(payload).forEach((k) => topLevelKeys.add(k));
      if (payload.attrs && typeof payload.attrs === "object") {
        Object.keys(payload.attrs).forEach((k) => attrKeys.add(k));
      }
    }

    console.log(`Sampled ${samples.length} rows.`);
    console.log(`\nTop-level payload keys: ${[...topLevelKeys].sort().join(", ")}`);
    console.log(`\nAttribute keys in payload.attrs:`);
    if (attrKeys.size === 0) {
      console.log("  (none)");
    } else {
      for (const key of [...attrKeys].sort()) {
        console.log(`  ${key}`);
      }
    }

    if (examplePayload) {
      console.log("\nExample payload (first row):");
      console.log(JSON.stringify(examplePayload, null, 2).split("\n").map((l) => "  " + l).join("\n"));
    }
  }

  // ── Latency-source check (for ToolLatencyCard) ─────────────────────────
  printSubsection("Latency-source check for ToolLatencyCard");

  const toolUseCount = db
    .prepare("SELECT COUNT(*) AS c FROM otel_events WHERE event_name = 'tool_use'")
    .get().c;
  console.log(`\ntool_use events: ${toolUseCount}`);

  const toolResultSample = db
    .prepare("SELECT payload_json FROM otel_events WHERE event_name = 'tool_result' LIMIT 10")
    .all();

  let hasDurationMs = false;
  for (const row of toolResultSample) {
    try {
      const p = JSON.parse(row.payload_json);
      if (p.attrs && ("duration_ms" in p.attrs || "durationMs" in p.attrs || "tool.duration_ms" in p.attrs)) {
        hasDurationMs = true;
      }
    } catch {}
  }

  if (toolResultSample.length === 0) {
    console.log("No tool_result events found — cannot assess latency source.");
  } else if (hasDurationMs) {
    console.log("✓ tool_result events have a duration_ms attribute — ToolLatencyCard can use it directly.");
  } else if (toolUseCount > 0) {
    console.log("No duration_ms on tool_result, but tool_use events exist.");
    console.log("→ ToolLatencyCard can pair tool_use_id across tool_use + tool_result and compute ts delta.");
  } else {
    console.log("⚠ No duration_ms on tool_result AND no tool_use events.");
    console.log("→ ToolLatencyCard has NO viable latency source. Defer to 8.1c.");
    console.log("  Document in INSIGHTS.md: Claude Code OTEL does not emit tool duration in this version.");
  }
}

// ── otel_metrics ─────────────────────────────────────────────────────────────

printSection("otel_metrics");

const totalMetrics = db.prepare("SELECT COUNT(*) AS c FROM otel_metrics").get().c;
console.log(`\nTotal rows: ${totalMetrics}`);

if (totalMetrics === 0) {
  console.log("\n⚠  No OTEL metric data points in the database yet.");
  console.log("   Metrics are emitted at session end — run a full Claude Code session and wait for it to stop.");
} else {
  const metricNames = db
    .prepare("SELECT DISTINCT metric_name, metric_type, COUNT(*) AS c FROM otel_metrics GROUP BY metric_name ORDER BY c DESC")
    .all();

  console.log("\nMetric names, types, and counts:");
  for (const row of metricNames) {
    console.log(`  ${row.metric_name.padEnd(36)} [${row.metric_type}]  ${String(row.c).padStart(6)} rows`);
  }

  for (const { metric_name } of metricNames) {
    printSubsection(`metric_name = "${metric_name}"`);

    const samples = db
      .prepare("SELECT * FROM otel_metrics WHERE metric_name = ? LIMIT 100")
      .all(metric_name);

    const attrsKeys = new Set();
    let exampleRow = null;

    for (const row of samples) {
      if (!exampleRow) exampleRow = row;
      if (row.attrs_json) {
        try {
          const attrs = JSON.parse(row.attrs_json);
          Object.keys(attrs).forEach((k) => attrsKeys.add(k));
        } catch {}
      }
    }

    const hasModel = samples.some((r) => r.model !== null);
    const hasSession = samples.some((r) => r.session_id !== null);

    console.log(`Sampled ${samples.length} rows.`);
    console.log(`model column populated: ${hasModel ? "yes" : "no (all NULL)"}`);
    console.log(`session_id column populated: ${hasSession ? "yes" : "no (all NULL)"}`);
    console.log(`attrs_json keys: ${attrsKeys.size > 0 ? [...attrsKeys].sort().join(", ") : "(none — all NULL)"}`);

    if (exampleRow) {
      console.log("\nExample row:");
      console.log(JSON.stringify(exampleRow, null, 2).split("\n").map((l) => "  " + l).join("\n"));
    }
  }
}

// ── Summary for otelQueries.ts contract comment ───────────────────────────────

printSection("Summary — paste this into src/lib/db/otelQueries.ts");

console.log(`
// OTEL attribute schema — doc-verified 2026-05-07 against code.claude.com/docs/en/monitoring-usage.
// Run scripts/probe-otel.mjs after capturing real traffic to confirm empirically.
//
// otel_events.ts: TEXT (ISO-8601)  — convert with CAST(strftime('%s', ts) AS INTEGER) * 1000
// otel_metrics.ts: INTEGER (ms epoch) — no conversion needed
//
// tool_decision (event.name = "tool_decision"):
//   tool_name             = "Edit" | "Write" | "NotebookEdit"
//   tool_use_id           = string
//   decision              = "accept" | "reject"   ← NOT tool_decision.was_accepted boolean
//   source                = "config" | "hook" | "user_permanent" | "user_temporary" | "user_abort" | "user_reject"
//
// tool_result (event.name = "tool_result"):
//   tool_name             = "Read" | "Edit" | "Write" | "Bash" | "mcp__*" | ...
//   tool_use_id           = string
//   success               = "true" | "false"   ← string, NOT boolean; NOT tool_result.is_error
//   duration_ms           = integer (ms) — present on all tool_result events
//   error_type            = string (when failed, e.g. "Error:ENOENT")
//   decision_type         = "accept" | "reject"
//   decision_source       = same values as tool_decision.source
//   tool_parameters       = JSON string (when OTEL_LOG_TOOL_DETAILS=1):
//                           Bash: bash_command, full_command, timeout
//                           MCP:  mcp_server_name, mcp_tool_name
//                           Skill: skill_name  Task: subagent_type
//
// api_request (event.name = "api_request"):
//   model, cost_usd, duration_ms, input_tokens, output_tokens,
//   cache_read_tokens, cache_creation_tokens, request_id, speed, query_source
//
// api_error (event.name = "api_error"):
//   model, error, status_code, duration_ms, attempt, request_id, speed, query_source
//
// api_retries_exhausted (event.name = "api_retries_exhausted"):
//   model, error, status_code, total_attempts, total_retry_duration_ms, speed
//
// hook_execution_complete (event.name = "hook_execution_complete"):
//   hook_event, hook_name, num_hooks, num_success, num_blocking,
//   num_non_blocking_error, num_cancelled, total_duration_ms
//   ← total_duration_ms is on this event directly; no start/complete pairing needed
//
// compaction (event.name = "compaction"):
//   trigger = "auto" | "manual", success, duration_ms, pre_tokens, post_tokens
//
// Metrics (otel_metrics.metric_name):
//   claude_code.token.usage:        type ("input"|"output"|"cacheRead"|"cacheCreation"), model, query_source
//   claude_code.cost.usage:         model, query_source
//   claude_code.session.count:      start_type ("fresh"|"resume"|"continue")
//   claude_code.code_edit_tool.decision: tool_name, decision, source, language
`);

db.close();
