"use client";

import { useState } from "react";
import { useReportFetch } from "@/hooks/useReportFetch";
import { Skeleton } from "@/components/ui/skeleton";
import { msLabel, defaultSince } from "@/lib/format";
import type { HookActivityResult, HookActivitySource } from "@/lib/db/otelQueries";

interface Props {
  since?: string;
}

/**
 * What each row's `name` actually is, per source.
 *
 * The two sources are never blended because they key on different things: OTEL
 * names the hook (`PreToolUse:Bash`), the transcript names the command it ran
 * (`codegraph sync`). Reading a `fires` count without knowing which of those
 * you are looking at makes the numbers non-comparable between visits — the
 * card used to render both identically, so `HookActivityResult.source` existed
 * and nothing surfaced it.
 */
const SOURCE_META: Record<
  NonNullable<HookActivityResult["source"]>,
  { label: string; column: string; explanation: string }
> = {
  otel: {
    label: "OTEL",
    // The first column header follows the source, because the column holds a
    // different thing in each. Labelling transcript rows "Hook" when they are
    // `codegraph sync` would undercut the badge sitting directly above it —
    // announcing that the semantics changed while still displaying the old
    // ones (Copilot review of #402).
    column: "Hook",
    explanation:
      "Rows are hook names, from OpenTelemetry hook_execution_complete events. Covers only the period since you enabled telemetry.",
  },
  transcript: {
    label: "transcript",
    column: "Command",
    explanation:
      "Rows are the commands each hook ran, decoded from session transcripts. Needs no setup and covers all history.",
  },
};

/** Header when the payload predates the `source` field and cannot say which it is. */
const UNKNOWN_SOURCE_COLUMN = "Hook";

const SOURCE_CHOICES: ReadonlyArray<{ value: HookActivitySource; label: string; hint: string }> = [
  {
    value: "auto",
    label: "Auto",
    hint: "Prefer OTEL, fall back to the transcript only when OTEL has nothing.",
  },
  { value: "otel", label: "OTEL", hint: SOURCE_META.otel.explanation },
  { value: "transcript", label: "Transcript", hint: SOURCE_META.transcript.explanation },
];

/**
 * Why this control exists rather than a date range.
 *
 * `auto` prefers OTEL and falls back only when OTEL returns nothing — and
 * `since` is a *lower* bound, so every window ending at now includes recent
 * events and no period ever falls back. Once OTEL has any data at all the
 * transcript view is unreachable, which on a typical machine hides tens of
 * thousands of transcript-derived runs behind the OTEL count. Asking for the
 * other pipeline has to be a direct request, because the two are not two views
 * of one dataset: OTEL names the hook, the transcript names the command it ran.
 */
function SourceToggle({
  value,
  onChange,
}: {
  value: HookActivitySource;
  onChange: (v: HookActivitySource) => void;
}) {
  // Segmented control, not a tab list — mutually-exclusive buttons with no
  // panels being switched. Matches `PeriodToggle` in ItemUsageBreakdown.
  return (
    <div
      role="group"
      aria-label="Hook activity source"
      style={{
        display: "inline-flex",
        gap: "4px",
        padding: "3px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
      }}
    >
      {SOURCE_CHOICES.map((c) => {
        const active = c.value === value;
        return (
          <button
            key={c.value}
            type="button"
            aria-pressed={active}
            title={c.hint}
            onClick={() => onChange(c.value)}
            style={{
              padding: "3px 9px",
              fontSize: "0.62rem",
              fontFamily: "var(--font-mono)",
              fontWeight: active ? 600 : 400,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: active ? "var(--text-primary)" : "var(--text-muted)",
              background: active ? "var(--bg-elevated)" : "transparent",
              border: "none",
              borderRadius: "calc(var(--radius) - 2px)",
              cursor: "pointer",
            }}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

/** Empty-state copy that names the source the reader actually asked for. */
function emptyMessage(source: HookActivitySource): string {
  if (source === "otel") {
    return "No OTEL hook events in this window. OTEL is opt-in — if you haven't enabled telemetry there is nothing to find here. Transcript needs no setup and covers all history.";
  }
  if (source === "transcript") {
    return "No hook runs decoded from session transcripts in this window.";
  }
  return "No hooks fired yet.";
}

export function HookActivityCard({ since }: Props) {
  const sinceParam = since ?? defaultSince();
  const [source, setSource] = useState<HookActivitySource>("auto");
  const { data, loading, error } = useReportFetch<HookActivityResult>(
    `/api/telemetry/hook-activity?since=${encodeURIComponent(sinceParam)}&source=${source}`,
  );

  // The toggle renders above every branch below, including the empty and error
  // ones. Putting it inside the has-data branch would let a reader pick a
  // source that happens to be empty and then have no control left to pick
  // their way back out of it.
  const toggle = (
    <div style={{ display: "flex", justifyContent: "flex-end", paddingBottom: "6px" }}>
      <SourceToggle value={source} onChange={setSource} />
    </div>
  );

  if (loading) {
    return (
      <div>
        {toggle}
        <Skeleton className="h-32" />
      </div>
    );
  }

  if (error || !data?.hasData) {
    return (
      <div>
        {toggle}
        <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem" }}>
          {error ? `Error: ${error}` : emptyMessage(source)}
        </div>
      </div>
    );
  }

  const maxFires = Math.max(...data.hooks.map((h) => h.fires), 1);
  // Fires nobody timed. Surfaced as visible text rather than left to a per-row
  // `title`, which is mouse-only — and which would otherwise be the single
  // place the reader learns that "—" means "not measured" and not "0 ms".
  //
  // `measuredFires` is optional on HookRow. Both producers set it, so the
  // fallback only covers a payload from an older build — and it falls back to
  // `fires`, contributing zero, because "the server didn't tell me" must not
  // render as "these went untimed".
  const unmeasured = data.hooks.reduce((n, h) => n + (h.fires - (h.measuredFires ?? h.fires)), 0);
  // Which pipeline actually answered, which is not the same as which one was
  // asked for: under `auto` the badge is the only place the resolution is
  // visible, and under an explicit pick it confirms the server honored it.
  const answered = data.source ? SOURCE_META[data.source] : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "8px", paddingBottom: "6px" }}>
        {answered && (
          <>
            <span className="sr-only">{answered.explanation}</span>
            <span
              aria-hidden="true"
              title={answered.explanation}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.58rem",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-muted)",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "3px",
                padding: "1px 6px",
                cursor: "help",
              }}
            >
              {answered.label}
            </span>
          </>
        )}
        <SourceToggle value={source} onChange={setSource} />
      </div>
      {/* Header */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 60px 60px", gap: "4px", paddingBottom: "6px", borderBottom: "1px solid var(--border-subtle)" }}>
        {[answered?.column ?? UNKNOWN_SOURCE_COLUMN, "Fires", "p50", "p95"].map((h) => (
          <span key={h} style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {h}
          </span>
        ))}
      </div>
      {data.hooks.map((hook) => (
        <div key={hook.name} style={{ display: "flex", flexDirection: "column", gap: "3px", padding: "3px 0" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 60px 60px", gap: "4px", alignItems: "center" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={hook.name}>
              {hook.name}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <div style={{
                height: "5px",
                width: `${Math.round((hook.fires / maxFires) * 64)}px`,
                background: "var(--info)",
                borderRadius: "2px",
                minWidth: "2px",
              }} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-secondary)" }}>
                {hook.fires}
              </span>
            </div>
            {/* An unmeasured hook shows "—", never "0ms". Claude Code records
                a command without a duration for roughly a fifth of executions,
                and 0ms would present the ones nobody timed as the fastest on
                the machine. The footer states the count so this is not
                mouse-only knowledge. */}
            <span
              title={hook.p50DurationMs === undefined ? "No duration was recorded for this hook" : undefined}
              style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-muted)" }}
            >
              {hook.p50DurationMs === undefined ? "—" : msLabel(hook.p50DurationMs)}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-muted)" }}>
              {hook.p95DurationMs === undefined ? "—" : msLabel(hook.p95DurationMs)}
            </span>
          </div>
        </div>
      ))}
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)", marginTop: "4px" }}>
        {data.totalFires} total executions
        {unmeasured > 0 && ` · ${unmeasured} not timed (shown as —)`}
      </div>
    </div>
  );
}
