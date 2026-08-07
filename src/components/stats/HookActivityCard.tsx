"use client";

import { useReportFetch } from "@/hooks/useReportFetch";
import { Skeleton } from "@/components/ui/skeleton";
import { msLabel, defaultSince } from "@/lib/format";
import type { HookActivityResult } from "@/lib/db/otelQueries";

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
  { label: string; explanation: string }
> = {
  otel: {
    label: "OTEL",
    explanation:
      "Rows are hook names, from OpenTelemetry hook_execution_complete events. Covers only the period since you enabled telemetry.",
  },
  transcript: {
    label: "transcript",
    explanation:
      "Rows are the commands each hook ran, decoded from session transcripts. Needs no setup and covers all history.",
  },
};

export function HookActivityCard({ since }: Props) {
  const sinceParam = since ?? defaultSince();
  const { data, loading, error } = useReportFetch<HookActivityResult>(
    `/api/telemetry/hook-activity?since=${encodeURIComponent(sinceParam)}`,
  );

  if (loading) return <Skeleton className="h-32" />;

  if (error || !data?.hasData) {
    return (
      <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem" }}>
        {error ? `Error: ${error}` : "No hooks fired yet."}
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
  const source = data.source ? SOURCE_META[data.source] : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      {source && (
        <div style={{ display: "flex", justifyContent: "flex-end", paddingBottom: "6px" }}>
          <span className="sr-only">{source.explanation}</span>
          <span
            aria-hidden="true"
            title={source.explanation}
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
            {source.label}
          </span>
        </div>
      )}
      {/* Header */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 60px 60px", gap: "4px", paddingBottom: "6px", borderBottom: "1px solid var(--border-subtle)" }}>
        {["Hook", "Fires", "p50", "p95"].map((h) => (
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
