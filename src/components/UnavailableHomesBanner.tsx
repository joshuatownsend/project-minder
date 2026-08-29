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
import type { SweepName, SweepFailureScope } from "@/lib/sweepFailures";

interface UnavailableHome {
  path: string;
  distro?: string;
  reason: string;
}

/**
 * An enumeration the SWEEPS could not complete (#513).
 *
 * Distinct from `UnavailableHome`, which is a home Minder decided not to touch.
 * These are directories it DID try to read and could not — a disconnected
 * drive, a moved home, changed permissions, one project directory with a
 * restrictive ACL. #479 could only report the first kind, so the corpus quietly
 * shrank for every case of the second.
 */
interface DegradedPath {
  path: string;
  // Imported rather than restated. A hand-copied `"usage" | "sessions"` drifted
  // the moment a third sweep name was added on the server, and a client
  // contract that silently disagrees with the API is how type-driven logic
  // starts excluding a valid value without anyone noticing. (Copilot, PR #527.)
  scope: SweepFailureScope;
  sweep: SweepName;
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
  // A non-WSL home has no distro to name, so it names itself.
  return home.distro ? `${home.distro} — ${why}` : `${home.path} — ${why}`;
}

/**
 * The never-wake line only applies to a distro that exists and is STOPPED.
 * "Minder will not start it" is confusing for `wsl-distro-not-found` and
 * `wsl-unavailable`, where there is nothing to start (Copilot, PR #510).
 */
function anyStopped(homes: UnavailableHome[]): boolean {
  return homes.some((h) => h.reason === "wsl-stopped");
}

export function UnavailableHomesBanner() {
  const [homes, setHomes] = useState<UnavailableHome[]>([]);
  const [degraded, setDegraded] = useState<DegradedPath[]>([]);
  // Separate from `degraded.length`, which is CAPPED at 50 detail entries. On a
  // broad fault — a permissions problem near the root of a large tree — the
  // banner used the array length and told the user that exactly 50 locations
  // failed, understating it in precisely the case where the number matters
  // most. The API already returns the uncapped figure; this reads it.
  // (Codex P2, PR #527, round 4.)
  const [degradedTotal, setDegradedTotal] = useState(0);
  /**
   * The DB reconcile's own verdict, which no in-process sweep can see.
   *
   * That pass runs in a worker and reports through the API rather than the
   * collector, so it arrives with `degradedTotal: 0` and no unavailable homes —
   * a state the banner had no way to render and therefore stayed silent for.
   * (Codex P2, PR #527.)
   */
  const [indexIncomplete, setIndexIncomplete] = useState(false);
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
        .then(
          (
            data: {
              unavailable?: UnavailableHome[];
              degraded?: DegradedPath[];
              degradedTotal?: number;
              complete?: boolean;
            } | null
          ) => {
            // A failed poll leaves the last good answer in place rather than
            // clearing the banner — a network blip is not evidence the home
            // came back, and flickering a warning off and on is worse than
            // stale.
            if (cancelled) return;
            if (data?.unavailable) setHomes(data.unavailable);
            // `??` NOT `if (data?.degraded)`: an empty array is the RECOVERY
            // signal, and treating it as "no news" would pin the banner up
            // after the permissions were fixed. The unavailable list above
            // keeps its truthiness check because a missing key there means an
            // older server, not a recovery.
            if (data) setDegraded(data.degraded ?? []);
            // Falls back to the detail length for an older server that does not
            // send the field — which is what the banner used to show anyway, so
            // the fallback is the previous behaviour rather than a new guess.
            if (data) setDegradedTotal(data.degradedTotal ?? (data.degraded ?? []).length);
            // Derived from `complete` rather than a field of its own: the
            // endpoint already publishes the whole-corpus answer, and asking
            // for a second field would let the two disagree. `complete === true`
            // with figures the client cannot account for is exactly the index
            // case. An older server sends no `complete`, and `?? true` keeps it
            // silent rather than warning about a field it never sent.
            if (data) {
              const whole = data.complete ?? true;
              setIndexIncomplete(
                !whole &&
                  (data.unavailable ?? []).length === 0 &&
                  (data.degradedTotal ?? (data.degraded ?? []).length) === 0
              );
            }
          }
        )
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Gated on the TOTAL, not on the detail array. `retireVerified` can clear
  // every retained detail while failures past the 50-entry cap remain counted,
  // so a `degraded.length` gate hid the banner outright while the API went on
  // reporting incomplete coverage — the silence this whole feature exists to
  // end, arriving through its own cap. (Codex P2, PR #527.)
  if (!allowRender || (homes.length === 0 && degradedTotal === 0 && !indexIncomplete))
    return null;

  const color = "var(--warn)";
  // Two different problems, and the headline names whichever is present. A home
  // Minder DECLINED to read is not the same as one it tried to read and could
  // not, and a reader who is told the wrong one goes looking in the wrong place.
  const headline =
    homes.length > 0
      ? homes.length === 1
        ? "One Claude home is unavailable"
        : `${homes.length} Claude homes are unavailable`
      : degradedTotal === 0 && indexIncomplete
        ? "The index did not finish reading your history"
        : degradedTotal === 1
          ? "Part of your history could not be read"
          : `${degradedTotal} locations could not be read`;

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
        {/* Only when there ARE unavailable homes. A degraded-only warning
            rendered this anyway and produced "may not account for ." — and
            went on to discuss an unreachable home's stale index, which is not
            what happened (Codex P2 + Copilot, PR #527). */}
        {homes.length > 0 && (
          <div style={{ color: "var(--text-3)", marginTop: 2 }}>
            Session, usage and cost figures may not account for{" "}
            {homes.map((h) => describe(h)).join("; ")}. Direct reads omit it
            entirely; the index still reports whatever it recorded when the home
            was last reachable.
            {anyStopped(homes) && " Minder will not start a stopped distro to check."}
          </div>
        )}
        {degradedTotal === 0 && indexIncomplete && (
          <div style={{ color: "var(--text-3)", marginTop: 4 }}>
            The last full index pass could not list one or more directories, so
            figures from the affected projects are missing rather than zero. The
            paths are not named here because the pass runs in a background
            worker and reports only whether it read through; the next sweep that
            succeeds clears this.
          </div>
        )}
        {degradedTotal > 0 && (
          <div style={{ color: "var(--text-3)", marginTop: 4 }}>
            {/* The paths, not just a count. "Something could not be read" is
                not actionable; the directory and the reason are. Capped,
                because a tree with a broken ACL near the root produces many
                and the first few are what a reader needs. */}
            {degraded.length === 0 ? (
              // Count-only copy. The paths are the actionable part and are
              // normally shown, but they can all have been retired while the
              // count has not — saying nothing at all would be worse than
              // saying how many.
              <>
                Could not read {degradedTotal}{" "}
                {degradedTotal === 1 ? "location" : "locations"}. Figures from the
                affected projects are missing rather than zero.
              </>
            ) : (
              <>
                Could not read{" "}
                {degradedTotal === 1 ? "" : `${degradedTotal} locations, including `}
                {degraded.slice(0, 3).map((d) => `${d.path} (${d.reason})`).join("; ")}
                {degradedTotal > 3 && ", and others"}. Figures from the affected
                projects are missing rather than zero.
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
