"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, Clock, GitBranch, Layers } from "lucide-react";

/**
 * T2.3b — portfolio surface for `background_tasks` + `session_crons`
 * arrays harvested from Stop / SubagentStop hook payloads (Claude Code
 * v2.1.145+). Data flows from `/api/hooks/background-activity`, which
 * reads from the in-memory ring buffer in `src/lib/hooks/buffer.ts`.
 *
 * Inner element shape is `unknown` because the public Claude Code docs
 * don't yet publish field names — we render whatever fields are present
 * via defensive runtime narrowing (string keys, primitive values).
 *
 * Limitation: the ring buffer evicts entries after 5 min. If a long-
 * running background task hasn't had a Stop event in the last 5 min,
 * it won't appear here even though the OS process is still running.
 * Documented in `docs/help/hooks.md`; persistence is a T2.4 follow-up.
 */

interface BackgroundActivityResponse {
  projects: Array<{
    slug: string;
    projectName: string;
    backgroundTasks: unknown[];
    sessionCrons: unknown[];
    lastObservedAt: number | null;
  }>;
  totals: {
    backgroundTasks: number;
    sessionCrons: number;
    projectsWithActivity: number;
  };
}

function formatRelative(ms: number | null): string {
  if (ms === null) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return new Date(ms).toLocaleString();
}

/**
 * Defensive renderer for unknown-shape array elements. Iterates own keys,
 * stringifies primitives, falls back to JSON.stringify for nested objects.
 * Keeps rows readable even when Claude Code adds new fields we haven't
 * typed yet.
 */
function renderUnknownEntry(entry: unknown): React.ReactNode {
  if (entry === null || typeof entry !== "object") {
    return <span style={{ fontFamily: "var(--font-mono)" }}>{String(entry)}</span>;
  }
  const obj = entry as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return <span style={{ color: "var(--text-muted)" }}>(empty)</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", fontSize: "0.75rem" }}>
      {keys.map((k) => {
        const v = obj[k];
        const display =
          v === null || v === undefined
            ? "—"
            : typeof v === "object"
              ? JSON.stringify(v)
              : String(v);
        return (
          <span key={k} style={{ display: "inline-flex", gap: "4px" }}>
            <span style={{ color: "var(--text-muted)" }}>{k}:</span>
            <span style={{ fontFamily: "var(--font-mono)" }}>{display}</span>
          </span>
        );
      })}
    </div>
  );
}

export function BackgroundActivityBrowser() {
  const [data, setData] = useState<BackgroundActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/hooks/background-activity")
        .then((r) => r.json())
        .then((j: BackgroundActivityResponse) => {
          if (!cancelled) {
            setData(j);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (loading) {
    return (
      <div style={{ padding: "32px", color: "var(--text-muted)" }}>
        Loading background activity…
      </div>
    );
  }

  if (!data || data.totals.projectsWithActivity === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <h1 style={{ fontSize: "1.5rem", margin: 0 }}>Background activity</h1>
        <p style={{ color: "var(--text-muted)" }}>
          No background tasks or session crons have been reported in the last 5 minutes.
        </p>
        <p style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
          Claude Code v2.1.145+ emits <code>background_tasks</code> and{" "}
          <code>session_crons</code> arrays on Stop / SubagentStop hook events.
          Data is held in an in-memory ring buffer and evicts after 5 minutes
          of inactivity — so a long-running task whose session hasn't recently
          fired a Stop event won&apos;t appear here.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div>
        <h1 style={{ fontSize: "1.5rem", margin: 0 }}>Background activity</h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginTop: "4px" }}>
          Recently-observed background tasks and session crons across{" "}
          {data.totals.projectsWithActivity} project
          {data.totals.projectsWithActivity === 1 ? "" : "s"}. Sourced from
          Stop / SubagentStop hook events in the last ~5 min.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "12px",
        }}
      >
        <StatCard
          label="Background tasks"
          value={data.totals.backgroundTasks}
          icon={<Activity className="h-4 w-4" />}
        />
        <StatCard
          label="Session crons"
          value={data.totals.sessionCrons}
          icon={<Clock className="h-4 w-4" />}
        />
        <StatCard
          label="Projects"
          value={data.totals.projectsWithActivity}
          icon={<Layers className="h-4 w-4" />}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {data.projects.map((p) => (
          <div
            key={p.slug}
            style={{
              borderRadius: "8px",
              border: "1px solid var(--border)",
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
              }}
            >
              <Link
                href={`/project/${p.slug}`}
                style={{
                  fontSize: "1rem",
                  fontWeight: 500,
                  color: "var(--text-primary)",
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <GitBranch aria-hidden="true" style={{ width: "14px", height: "14px" }} />
                {p.projectName}
              </Link>
              <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                last observed {formatRelative(p.lastObservedAt)}
              </span>
            </div>

            {p.backgroundTasks.length > 0 && (
              <section>
                <h3
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 500,
                    color: "var(--text-muted)",
                    margin: "0 0 8px 0",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  Background tasks ({p.backgroundTasks.length})
                </h3>
                <ul
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  {p.backgroundTasks.map((t, i) => (
                    <li
                      key={i}
                      style={{
                        padding: "8px 12px",
                        borderRadius: "4px",
                        background: "var(--muted)",
                      }}
                    >
                      {renderUnknownEntry(t)}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {p.sessionCrons.length > 0 && (
              <section>
                <h3
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 500,
                    color: "var(--text-muted)",
                    margin: "0 0 8px 0",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  Session crons ({p.sessionCrons.length})
                </h3>
                <ul
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  {p.sessionCrons.map((c, i) => (
                    <li
                      key={i}
                      style={{
                        padding: "8px 12px",
                        borderRadius: "4px",
                        background: "var(--muted)",
                      }}
                    >
                      {renderUnknownEntry(c)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <div
      style={{
        borderRadius: "8px",
        border: "1px solid var(--border)",
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          color: "var(--text-muted)",
          fontSize: "0.75rem",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {icon}
        {label}
      </span>
      <span style={{ fontSize: "1.5rem", fontWeight: 500 }}>{value}</span>
    </div>
  );
}
