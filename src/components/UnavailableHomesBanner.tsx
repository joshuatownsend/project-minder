"use client";

/**
 * UnavailableHomesBanner — says out loud when a configured Claude home cannot
 * be read this cycle, so totals that are quietly missing a home stop being
 * quiet (#479).
 *
 * A home inside a stopped WSL distro is excluded from every read, deliberately:
 * touching it would auto-start the VM, which is the never-wake invariant from
 * #307/#308. The exclusion was also silent, and the two backends disagree about
 * what to do with it — file-parse answers over readable homes only, while
 * SQLite retains rows indexed when that home was last up. Neither answer is
 * right, and which is less wrong depends on how much of the corpus lives in the
 * unreachable home. That is the user's judgement to make, so this reports the
 * fact rather than making it for them.
 *
 * Renders nothing when every home answers, which is the normal case and the
 * only case on a single-home machine.
 */

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

interface UnavailableHome {
  path: string;
  distro?: string;
  reason: string;
}

const POLL_MS = 60_000;

/**
 * Same 600ms suppression `ClaudeStatusBanner` uses, for the same reason: the
 * banner must not flash on every navigation before the first poll resolves.
 */
const SUPPRESS_FIRST_RENDER_MS = 600;

const REASON_LABELS: Record<string, string> = {
  "wsl-stopped": "the distro is not running",
  "wsl-distro-not-found": "the distro is not installed",
  "wsl-unavailable": "WSL is unavailable",
};

function describe(home: UnavailableHome): string {
  const why = REASON_LABELS[home.reason] ?? home.reason;
  return home.distro ? `${home.distro} — ${why}` : why;
}

export function UnavailableHomesBanner() {
  const [homes, setHomes] = useState<UnavailableHome[]>([]);
  const [allowRender, setAllowRender] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setAllowRender(true), SUPPRESS_FIRST_RENDER_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetch("/api/claude-homes")
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { unavailable?: UnavailableHome[] } | null) => {
          // A failed poll leaves the last good answer in place rather than
          // clearing the banner — a network blip is not evidence the home came
          // back, and flickering a warning off and on is worse than stale.
          if (!cancelled && data?.unavailable) setHomes(data.unavailable);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!allowRender || homes.length === 0) return null;

  const color = "var(--warn)";
  const headline =
    homes.length === 1
      ? "One Claude home is unavailable"
      : `${homes.length} Claude homes are unavailable`;

  return (
    <div
      role="status"
      aria-live="polite"
      data-unavailable-homes={homes.length}
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
        <div style={{ color: "var(--text-3)", marginTop: 2 }}>
          Sessions, usage and cost totals below exclude{" "}
          {homes.map((h) => describe(h)).join("; ")}. Minder will not start a
          stopped distro to read it.
        </div>
      </div>
    </div>
  );
}
