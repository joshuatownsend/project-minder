"use client";

import { useEffect, useRef, useState } from "react";
import type { QuotaWindow } from "@/lib/quota";
import type { ScheduleMode } from "@/lib/types";
import {
  computeBurnHeadline,
  computeCapTimeMs,
  computeProjectedUtilization,
  formatCountdown,
  scheduleLabel,
  utilColor,
  DEFAULT_SCHEDULE_MODE,
  type WindowKey,
} from "@/lib/quotaProjection";
import { useQuota } from "@/hooks/useQuota";
import { useConfig, useBurnHudEnabled } from "./ConfigProvider";
import { useHelp } from "./HelpProvider";

/**
 * Persistent burn HUD (agentic-os-dashboard port #2). A compact top-bar chip
 * that always surfaces the more-utilized of the account's 5h/7d rate-limit
 * windows plus a projected cap time, so you can see how close you are to a
 * throttle without opening /settings. Clicking opens a popover with all three
 * windows (5h / 7d / overage), their reset countdowns, and schedule-aware
 * projections.
 *
 * Reads the same authoritative `anthropic-ratelimit-unified-*` headers the
 * burndown chart uses (via `useQuota`). Self-gating on three counts, so the top
 * bar never shows a broken or empty chip:
 *   - the `burnHud` feature flag is off (explicit opt-out), or
 *   - Claude quota isn't configured (no OAuth creds / probe failed), or
 *   - the first fetch hasn't resolved yet.
 */

/** "3:40 PM" — locale-aware clock for a projected cap moment. */
function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function QuotaHud() {
  const enabled = useBurnHudEnabled();
  const config = useConfig();
  // Only touch the quota API once we KNOW the flag is on — config resolved
  // (not still loading) AND enabled. This makes the opt-out a real opt-out: a
  // disabled HUD issues no /api/integrations/quota fetch and no Anthropic probe,
  // not just a hidden chip. Persistent surface, so we poll every 60s; the client
  // only refetches once its own 5-min TTL lapses, so this is a cheap poll.
  const quotaActive = config !== null && enabled;
  const quota = useQuota(60_000, quotaActive);
  const { openHelp } = useHelp();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Live-ticking clock so the countdowns + cap time stay honest without a
  // refetch. Matches QuotaBurndownChart's 60s cadence.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Close the popover on outside click or Escape (same affordance as the MCP strip).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!enabled) return null;
  if (!quota || !quota.configured) return null; // loading, no creds, or probe failed

  const scheduleMode: ScheduleMode = config?.scheduleMode ?? DEFAULT_SCHEDULE_MODE;
  const headline = computeBurnHeadline(quota.windows, nowMs);
  const pct = Math.round(headline.worstUtil * 100);
  const color = utilColor(headline.worstUtil);
  const capText = headline.capAtMs !== null ? `cap ~${formatClock(headline.capAtMs)}` : null;

  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Rate-limit burn — ${headline.worstKey} window at ${pct}%${capText ? `, ${capText}` : ""}`}
        title="Rate-limit burn — click for details"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          whiteSpace: "nowrap",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: "2px 4px",
          borderRadius: 6,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: "0.04em",
            color: "var(--text-3)",
          }}
        >
          BURN
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, color }}>
          {pct}%
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--text-3)" }}>
          {headline.worstKey}
        </span>
        {capText && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color }}>{capText}</span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Rate-limit burn"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 50,
            width: 320,
            background: "var(--surface-1, #161b22)",
            border: "1px solid var(--border, #30363d)",
            borderRadius: 10,
            boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
            padding: 10,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
              paddingBottom: 8,
              borderBottom: "1px solid var(--border, #30363d)",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-1, #e6edf3)" }}>
              Rate-limit burn
              <span style={{ color: "var(--text-3)", fontWeight: 400 }}>
                {" "}
                · {quota.subscriptionType}
              </span>
            </span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openHelp("burn-hud");
              }}
              aria-label="About the burn HUD"
              title="About the burn HUD"
              style={{
                background: "transparent",
                border: "1px solid var(--border, #30363d)",
                color: "var(--text-3)",
                borderRadius: 6,
                width: 20,
                height: 20,
                fontSize: 11,
                lineHeight: 1,
                cursor: "pointer",
              }}
            >
              ?
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <WindowRow label="5-hour window" window={quota.windows["5h"]} windowKey="5h" scheduleMode={scheduleMode} nowMs={nowMs} />
            <WindowRow label="7-day window" window={quota.windows["7d"]} windowKey="7d" scheduleMode={scheduleMode} nowMs={nowMs} />
            <OverageRow window={quota.windows.overage} nowMs={nowMs} />
          </div>

          <div
            style={{
              marginTop: 8,
              paddingTop: 8,
              borderTop: "1px solid var(--border, #30363d)",
              fontSize: 10.5,
              color: "var(--text-3)",
              lineHeight: 1.4,
            }}
          >
            {scheduleLabel(scheduleMode)} schedule · projection assumes the current rate holds.
            Cached {new Date(quota.cachedAt).toLocaleTimeString()}.
          </div>
        </div>
      )}
    </div>
  );
}

function Bar({ util, color }: { util: number; color: string }) {
  return (
    <div style={{ height: 6, borderRadius: 3, background: "var(--border-subtle, #30363d)", overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${Math.min(util, 1) * 100}%`, background: color, borderRadius: 3 }} />
    </div>
  );
}

function WindowRow({
  label,
  window,
  windowKey,
  scheduleMode,
  nowMs,
}: {
  label: string;
  window: QuotaWindow;
  windowKey: WindowKey;
  scheduleMode: ScheduleMode;
  nowMs: number;
}) {
  const pct = Math.round(window.utilization * 100);
  const color = utilColor(window.utilization);
  const secsLeft = Math.max(0, window.reset - nowMs / 1000);
  const projected = computeProjectedUtilization(window, windowKey, scheduleMode, nowMs);
  const projPct = projected !== null ? Math.round(projected * 100) : null;
  const capMs = computeCapTimeMs(window, windowKey, nowMs);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "var(--text-2, #c9d1d9)" }}>{label}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, color }}>{pct}%</span>
      </div>
      <Bar util={window.utilization} color={color} />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 3,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--text-3)",
        }}
      >
        <span>resets in {formatCountdown(secsLeft)}</span>
        {capMs !== null ? (
          <span style={{ color }}>cap ~{formatClock(capMs)}</span>
        ) : projPct !== null ? (
          <span style={{ color: projPct >= 90 ? "var(--status-error-text, #f87171)" : projPct >= 70 ? "var(--warning, #fb923c)" : "var(--text-3)" }}>
            ~{projPct}% projected
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Overage is only meaningful once it's actually in play (reset set / util > 0). */
function OverageRow({ window, nowMs }: { window: QuotaWindow; nowMs: number }) {
  if (window.reset <= 0 && window.utilization <= 0) return null;
  const pct = Math.round(window.utilization * 100);
  const color = utilColor(window.utilization);
  const secsLeft = Math.max(0, window.reset - nowMs / 1000);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "var(--text-2, #c9d1d9)" }}>Overage</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, color }}>{pct}%</span>
      </div>
      <Bar util={window.utilization} color={color} />
      {window.reset > 0 && (
        <div style={{ marginTop: 3, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-3)" }}>
          resets in {formatCountdown(secsLeft)}
        </div>
      )}
    </div>
  );
}
