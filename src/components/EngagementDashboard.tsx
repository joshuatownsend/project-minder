"use client";

import { useMemo, useState } from "react";
import { useEngagement } from "@/hooks/useEngagement";
import { useProjects } from "@/hooks/useProjects";
import { COST_PERIODS } from "@/lib/usage/constants";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProjectData } from "@/lib/types";

const DEFAULT_PERIOD = "30d";

/** `C--dev-my-app` → `my-app`, for usage rows with no scanned project. */
function decodeDirName(encoded: string): string {
  const withoutDrive = encoded.replace(/^[A-Za-z]--/, "");
  const firstDash = withoutDrive.indexOf("-");
  return firstDash === -1 ? withoutDrive : withoutDrive.slice(firstDash + 1);
}

/** Hours as `3.75 h` — timecards are filed in decimal hours, not h:mm. */
function fmtHours(h: number): string {
  return `${h.toFixed(2)} h`;
}

export function EngagementDashboard(
  { project, home }: { project?: string; home?: string } = {},
) {
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const [responseMinutes, setResponseMinutes] = useState(15);
  const [runCapMinutes, setRunCapMinutes] = useState(30);
  const [tailMinutes, setTailMinutes] = useState(3);

  const { data, loading, fetching, error } = useEngagement(
    period, project, responseMinutes, runCapMinutes, tailMinutes, home,
  );
  const { data: scan } = useProjects();

  const nameByUsageSlug = useMemo(() => {
    const m = new Map<string, ProjectData>();
    for (const p of scan?.projects ?? []) m.set(p.usageSlug, p);
    return m;
  }, [scan]);

  // The daily rows carry only a dir name, so the slug has to come from the
  // per-project rows. Without this the breakdown column showed decoded dir
  // names while the table above it showed real project names.
  const slugByDirName = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of data?.byProject ?? []) m.set(p.projectDirName, p.projectSlug);
    return m;
  }, [data]);

  const nameFor = (dirName: string, slug?: string | null) => {
    const resolved = slug ?? slugByDirName.get(dirName) ?? null;
    return (resolved ? nameByUsageSlug.get(resolved)?.name : undefined) ?? decodeDirName(dirName);
  };

  const exportHref = useMemo(() => {
    const params = new URLSearchParams({
      period,
      responseMinutes: String(responseMinutes),
      runCapMinutes: String(runCapMinutes),
      tailMinutes: String(tailMinutes),
      format: "csv",
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
    if (project) params.set("project", project);
    if (home) params.set("home", home);
    return `/api/engagement/export?${params}`;
  }, [period, project, home, responseMinutes, runCapMinutes, tailMinutes]);

  if (error) {
    return (
      <div style={{
        padding: "28px", border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)", background: "var(--bg-surface)",
        color: "var(--text-secondary)", fontSize: "0.8rem",
        fontFamily: "var(--font-body)",
      }}>
        <strong style={{ color: "var(--text-primary)" }}>Engagement report unavailable.</strong>
        <div style={{ marginTop: "8px" }}>{error}</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <h1 style={{
          fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)",
          fontFamily: "var(--font-body)", letterSpacing: "-0.01em", margin: 0,
        }}>
          {project ? "Engagement" : "Timecard — human engagement"}
        </h1>

        <div style={{
          display: "flex", background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)", overflow: "hidden",
        }}>
          {COST_PERIODS.map((p, i) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              style={{
                padding: "5px 11px", fontSize: "0.72rem",
                fontFamily: "var(--font-body)", letterSpacing: "0.03em",
                color: period === p.value ? "var(--text-primary)" : "var(--text-secondary)",
                background: period === p.value ? "var(--bg-elevated)" : "transparent",
                border: "none",
                borderRight: i < COST_PERIODS.length - 1 ? "1px solid var(--border-subtle)" : "none",
                cursor: "pointer", lineHeight: 1,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <a
          href={exportHref}
          style={{
            fontSize: "0.72rem", fontFamily: "var(--font-body)",
            color: "var(--text-primary)", background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)",
            padding: "5px 11px", textDecoration: "none",
          }}
        >
          Export CSV
        </a>
      </div>

      {/* ── Headline ───────────────────────────────────────────────────── */}
      {loading && !data ? (
        <Skeleton className="h-24" />
      ) : !data ? null : (
        <div style={{
          display: "flex", gap: "28px", flexWrap: "wrap",
          padding: "16px 18px", background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)",
          opacity: fetching ? 0.6 : 1, transition: "opacity 0.15s",
        }}>
          <Stat label="Billable" value={fmtHours(data.totalHours)} emphasis />
          <Stat label="Before overlap discount" value={fmtHours(data.rawHours)} />
          <Stat
            label="Concurrency discount"
            value={data.overlapHours > 0 ? `−${fmtHours(data.overlapHours)}` : "none"}
          />
          <Stat label="Active days" value={String(data.byDay.length)} />
          <Stat label="Timezone" value={data.timeZone} />
        </div>
      )}

      {/* ── Threshold controls ─────────────────────────────────────────── */}
      <div style={{
        padding: "14px 18px", background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)",
        display: "flex", flexDirection: "column", gap: "12px",
      }}>
        <div style={{
          fontSize: "0.7rem", letterSpacing: "0.06em", textTransform: "uppercase",
          color: "var(--text-muted)", fontFamily: "var(--font-body)",
        }}>
          Thresholds
        </div>
        <Slider
          label="Idle threshold"
          hint="How long the agent may sit silent before your next prompt and still count as you watching. Measured knee in this corpus: 15 min."
          min={1} max={60} value={responseMinutes} onChange={setResponseMinutes}
        />
        <Slider
          label="Agent-run cap"
          hint="Most credit one uninterrupted agent run can earn. p95 of observed runs: 30 min."
          min={5} max={120} value={runCapMinutes} onChange={setRunCapMinutes}
        />
        <Slider
          label="Tail credit"
          hint="Flat allowance per block for reading and verifying after your last prompt, which leaves no transcript trace."
          min={0} max={15} value={tailMinutes} onChange={setTailMinutes}
        />
      </div>

      {/* ── Per-project ────────────────────────────────────────────────── */}
      {!project && data && data.byProject.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{
            width: "100%", borderCollapse: "collapse",
            fontFamily: "var(--font-mono)", fontSize: "0.74rem",
          }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                <Th label="Project" align="left" />
                <Th label="Billable" align="right" />
                <Th label="Raw" align="right" />
                <Th label="Prompts" align="right" />
                <Th label="Days" align="right" />
              </tr>
            </thead>
            <tbody>
              {data.byProject.map((p) => (
                <tr key={p.projectDirName} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                  <Td align="left">{nameFor(p.projectDirName, p.projectSlug)}</Td>
                  <Td align="right" emphasis>{p.allocatedHours.toFixed(2)}</Td>
                  <Td align="right" muted>{p.rawHours.toFixed(2)}</Td>
                  <Td align="right" muted>{p.promptCount}</Td>
                  <Td align="right" muted>{p.activeDays}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Daily timecard ─────────────────────────────────────────────── */}
      {data && data.byDay.length > 0 && (
        <div>
          <div style={{
            fontSize: "0.7rem", letterSpacing: "0.06em", textTransform: "uppercase",
            color: "var(--text-muted)", fontFamily: "var(--font-body)",
            marginBottom: "10px",
          }}>
            Daily
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{
              width: "100%", borderCollapse: "collapse",
              fontFamily: "var(--font-mono)", fontSize: "0.74rem",
            }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                  <Th label="Date" align="left" />
                  <Th label="Hours" align="right" />
                  <Th label="Breakdown" align="left" />
                </tr>
              </thead>
              <tbody>
                {data.byDay.map((d) => (
                  <tr key={d.date} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                    <Td align="left">{d.date}</Td>
                    <Td align="right" emphasis>{d.totalHours.toFixed(2)}</Td>
                    <Td align="left" muted>
                      {d.byProject
                        .map((p) => `${nameFor(p.projectDirName)} ${p.hours.toFixed(2)}`)
                        .join("  ·  ")}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && data.byDay.length === 0 && !fetching && (
        <div style={{
          padding: "40px", textAlign: "center", color: "var(--text-muted)",
          fontSize: "0.8rem", fontFamily: "var(--font-body)",
        }}>
          No attended time in this period.
        </div>
      )}

      {/* ── Provenance ─────────────────────────────────────────────────── */}
      {data && (
        <div style={{
          fontSize: "0.68rem", lineHeight: 1.6, color: "var(--text-muted)",
          fontFamily: "var(--font-body)", borderTop: "1px solid var(--border-subtle)",
          paddingTop: "12px",
        }}>
          Attended time is credited when you answered within{" "}
          <strong>{responseMinutes} min</strong> of the agent falling silent; one agent run
          earns at most <strong>{runCapMinutes} min</strong>, and each block carries{" "}
          <strong>{tailMinutes} min</strong> of tail credit. Work on two projects in the same
          minute is split evenly between them, so per-project hours sum to the day&rsquo;s
          total rather than exceeding it. Automated SDK sessions are excluded
          {data.excludedAutomatedSessions > 0
            ? ` (${data.excludedAutomatedSessions} in this period)`
            : ""}
          .
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div>
      <div style={{
        fontSize: "0.65rem", letterSpacing: "0.06em", textTransform: "uppercase",
        color: "var(--text-muted)", fontFamily: "var(--font-body)", marginBottom: "4px",
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: "var(--font-mono)",
        fontSize: emphasis ? "1.35rem" : "0.95rem",
        fontWeight: emphasis ? 700 : 400,
        color: emphasis ? "var(--text-primary)" : "var(--text-secondary)",
      }}>
        {value}
      </div>
    </div>
  );
}

function Slider({
  label, hint, min, max, value, onChange,
}: {
  label: string; hint: string; min: number; max: number;
  value: number; onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
      <div style={{ width: "140px", flexShrink: 0 }}>
        <div style={{
          fontSize: "0.74rem", color: "var(--text-primary)",
          fontFamily: "var(--font-body)",
        }}>
          {label}
        </div>
      </div>
      <input
        type="range"
        min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={`${label} in minutes`}
        style={{ flex: "1 1 200px", accentColor: "var(--accent, #f59e0b)" }}
      />
      <div style={{
        width: "62px", textAlign: "right", fontFamily: "var(--font-mono)",
        fontSize: "0.74rem", color: "var(--text-primary)",
      }}>
        {value} min
      </div>
      <div style={{
        flexBasis: "100%", fontSize: "0.66rem", color: "var(--text-muted)",
        fontFamily: "var(--font-body)", paddingLeft: "154px",
      }}>
        {hint}
      </div>
    </div>
  );
}

function Th({ label, align }: { label: string; align: "left" | "right" }) {
  return (
    <th style={{
      textAlign: align, padding: "7px 10px", fontWeight: 500,
      fontSize: "0.68rem", letterSpacing: "0.05em", textTransform: "uppercase",
      color: "var(--text-muted)", fontFamily: "var(--font-body)",
    }}>
      {label}
    </th>
  );
}

function Td({
  children, align, muted, emphasis,
}: {
  children: React.ReactNode; align: "left" | "right";
  muted?: boolean; emphasis?: boolean;
}) {
  return (
    <td style={{
      textAlign: align, padding: "7px 10px",
      color: muted ? "var(--text-muted)" : "var(--text-primary)",
      fontWeight: emphasis ? 700 : 400,
    }}>
      {children}
    </td>
  );
}
