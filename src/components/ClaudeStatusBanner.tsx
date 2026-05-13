"use client";

/**
 * ClaudeStatusBanner — sticky cross-route banner that surfaces active
 * incidents from status.claude.com.
 *
 * Renders nothing when:
 *   - The feature flag is off (server replies `{disabled: true}`)
 *   - Overall status is `operational` (regardless of source — once we know
 *     things are fine, the banner is hidden even if the snapshot is stale)
 *   - The first poll hasn't completed within the initial 600ms suppress window
 *
 * Polls `/api/claude-status` every 60s. State only updates on successful
 * fetches — a transient network blip leaves the last good banner in place.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import type { ClaudeStatusSnapshot, OverallStatus } from "@/lib/claudeStatus/types";

const POLL_INTERVAL_MS = 60_000;
const SUPPRESS_FIRST_RENDER_MS = 600;

type ApiResponse = ClaudeStatusSnapshot | { disabled: true };

function isDisabled(r: ApiResponse): r is { disabled: true } {
  return (r as { disabled?: boolean }).disabled === true;
}

function bannerTone(overall: OverallStatus): "warn" | "danger" | null {
  if (overall === "incident") return "danger";
  if (overall === "degraded") return "warn";
  return null;
}

function ageLabel(fetchedAt: number): string {
  if (!fetchedAt) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function ClaudeStatusBanner() {
  const [snapshot, setSnapshot] = useState<ClaudeStatusSnapshot | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [allowRender, setAllowRender] = useState(false);

  // Suppress any UI for the first 600ms so the banner doesn't flash on
  // every page nav before the poll resolves.
  useEffect(() => {
    const t = setTimeout(() => setAllowRender(true), SUPPRESS_FIRST_RENDER_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    async function pull() {
      try {
        const res = await fetch("/api/claude-status", { signal: ctrl.signal });
        if (!res.ok) return;
        const data = (await res.json()) as ApiResponse;
        if (cancelled) return;
        if (isDisabled(data)) {
          setDisabled(true);
          setSnapshot(null);
          return;
        }
        setDisabled(false);
        setSnapshot(data);
      } catch {
        // Keep the last good snapshot; transient errors shouldn't unmount the banner.
      }
    }

    pull();
    const id = setInterval(pull, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, []);

  if (!allowRender || disabled || !snapshot) return null;
  const tone = bannerTone(snapshot.overall);
  if (!tone) return null;

  const isStale = snapshot.source === "stale";
  const color = tone === "danger" ? "var(--danger)" : "var(--warn)";

  const incident = snapshot.incidents[0];
  const degradedComponents = snapshot.components.filter((c) => c.status !== "operational");

  // Headline + detail line are derived once so server logic stays out
  // of the JSX tree.
  const headline = incident
    ? `Claude incident: ${incident.name}`
    : degradedComponents.length === 1
    ? `${degradedComponents[0].name}: ${degradedComponents[0].status.replace(/_/g, " ")}`
    : `${degradedComponents.length} Claude services degraded`;

  const detail = incident?.latestUpdateBody
    ?? (degradedComponents.length > 1
      ? degradedComponents.map((c) => c.name).join(", ")
      : null);

  const linkHref = incident?.shortlink ?? snapshot.page.url;
  const linkLabel = incident ? "View incident" : "Status page";

  return (
    <div
      role="status"
      aria-live="polite"
      data-claude-status={tone}
      style={{
        margin: "8px 14px 0",
        padding: "8px 12px",
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: `color-mix(in oklch, ${color} 55%, transparent)`,
        background: `linear-gradient(90deg, color-mix(in oklch, ${color} 12%, transparent), transparent 65%)`,
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 12,
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: 6,
          background: `color-mix(in oklch, ${color} 22%, transparent)`,
          color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <AlertTriangle width={14} height={14} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{headline}</div>
        {detail && (
          <div
            style={{
              color: "var(--text-3)",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {detail}
          </div>
        )}
      </div>
      {isStale && (
        <span style={{ color: "var(--text-4)", fontSize: 11, whiteSpace: "nowrap" }}>
          Last checked {ageLabel(snapshot.fetchedAt)}
        </span>
      )}
      <Link
        href={linkHref}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: "var(--text-2)",
          textDecoration: "none",
          padding: "4px 10px",
          borderRadius: 6,
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: "var(--border)",
          whiteSpace: "nowrap",
          fontWeight: 500,
        }}
      >
        {linkLabel}
      </Link>
    </div>
  );
}
