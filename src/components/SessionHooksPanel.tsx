"use client";

import { AlertTriangle, Ban } from "lucide-react";
import { summarizeSessionHooks } from "@/lib/sessions/hookSummary";
import { msLabel, formatDurationMs } from "@/lib/format";
import type { SessionHookRun, SessionHookError } from "@/lib/types/session";

interface Props {
  hookRuns?: SessionHookRun[];
  hookErrors?: SessionHookError[];
}

const mono = (size: string, color: string) => ({
  fontFamily: "var(--font-mono)",
  fontSize: size,
  color,
});

const COLS = "1fr 60px 78px 62px 62px";

/**
 * What hooks cost this one session.
 *
 * Reads `hookRuns` straight off the detail payload — no fetch. Both backends
 * populate it (`sessionDetailFromDb.ts` from `session_hook_runs`,
 * `claudeConversations.ts` from `hookInfos` on system entries), so this renders
 * identically under `MINDER_USE_DB=0`, and the demo fixtures carry runs too.
 */
export function SessionHooksPanel({ hookRuns, hookErrors }: Props) {
  const summary = summarizeSessionHooks(hookRuns);
  const unmeasured = summary.totalFires - summary.measuredFires;
  const maxTotal = Math.max(...summary.groups.map((g) => g.totalMs), 1);
  const errors = hookErrors ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Headline. Suppressed when the session recorded only failures — the
          tab opens on errors alone, and "0s in hooks · 0 runs" would be three
          zeroes standing in for "no runs were recorded", which the empty table
          already says by not being there. */}
      {summary.totalFires > 0 && (
        <div style={{ display: "flex", alignItems: "baseline", gap: "16px", flexWrap: "wrap" }}>
          <div>
            <div style={{ ...mono("1.1rem", "var(--text-primary)"), fontWeight: 600 }}>
              {summary.measuredFires > 0 ? formatDurationMs(summary.totalMs) : "—"}
            </div>
            <div style={mono("0.6rem", "var(--text-muted)")}>in hooks</div>
          </div>
          <div style={mono("0.68rem", "var(--text-secondary)")}>
            {summary.totalFires} {summary.totalFires === 1 ? "run" : "runs"} ·{" "}
            {summary.groups.length} {summary.groups.length === 1 ? "command" : "commands"}
            {/* Stated up front, because it bounds every number above it: the
                total is the sum of what was measured, and these were not. */}
            {unmeasured > 0 && ` · ${unmeasured} not timed`}
          </div>
        </div>
      )}

      {summary.groups.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <div style={{ display: "grid", gridTemplateColumns: COLS, gap: "6px", paddingBottom: "6px", borderBottom: "1px solid var(--border-subtle)" }}>
            {["Command", "Runs", "Total", "p50", "Max"].map((h) => (
              <span key={h} style={{ ...mono("0.6rem", "var(--text-muted)"), textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {h}
              </span>
            ))}
          </div>

          {summary.groups.map((g) => (
            <div key={g.command} style={{ display: "grid", gridTemplateColumns: COLS, gap: "6px", alignItems: "center", padding: "4px 0" }}>
              <span
                style={{ ...mono("0.7rem", "var(--text-secondary)"), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={g.command}
              >
                {g.command}
              </span>
              <span style={mono("0.68rem", "var(--text-secondary)")}>
                {g.fires}
                {g.measuredFires < g.fires && (
                  <span style={mono("0.6rem", "var(--text-muted)")}> ({g.measuredFires} timed)</span>
                )}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                <div style={{
                  height: "5px",
                  width: `${Math.round((g.totalMs / maxTotal) * 34)}px`,
                  background: "var(--info)",
                  borderRadius: "2px",
                  minWidth: g.totalMs > 0 ? "2px" : "0px",
                }} />
                <span style={mono("0.68rem", "var(--text-secondary)")}>
                  {g.measuredFires > 0 ? msLabel(g.totalMs) : "—"}
                </span>
              </div>
              {/* "—" rather than 0ms wherever nothing was measured. */}
              <span style={mono("0.68rem", "var(--text-muted)")}>
                {g.p50Ms === undefined ? "—" : msLabel(g.p50Ms)}
              </span>
              <span style={mono("0.68rem", "var(--text-muted)")}>
                {g.maxMs === undefined ? "—" : msLabel(g.maxMs)}
              </span>
            </div>
          ))}
        </div>
      )}

      {errors.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ ...mono("0.6rem", "var(--text-muted)"), textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {errors.length} {errors.length === 1 ? "failure" : "failures"}
          </div>
          {/* Blocking and advisory failures look nothing alike in consequence,
              so they must not look alike here. `hookErrors` is a sibling array
              of the hook records rather than a field on one, so a failure
              cannot be attributed to a specific command — the rows carry no
              command for that reason. */}
          {errors.map((e, i) => {
            const blocking = e.preventedContinuation;
            const Icon = blocking ? Ban : AlertTriangle;
            const tone = blocking ? "var(--status-error-text)" : "var(--accent)";
            return (
              <div
                key={`${e.ts ?? "no-ts"}-${i}`}
                style={{
                  display: "flex", alignItems: "flex-start", gap: "7px",
                  padding: "7px 9px",
                  background: "var(--bg-elevated)",
                  border: `1px solid ${blocking ? "var(--status-error-text)" : "var(--border-subtle)"}`,
                  borderRadius: "3px",
                }}
              >
                <Icon style={{ width: "12px", height: "12px", color: tone, flexShrink: 0, marginTop: "1px" }} />
                <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                  <span style={{ ...mono("0.6rem", tone), textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {blocking ? "blocked the turn" : "advisory"}
                  </span>
                  <span style={{ ...mono("0.7rem", "var(--text-secondary)"), wordBreak: "break-word" }}>
                    {e.message}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
