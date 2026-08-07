"use client";

import { useEffect, useState } from "react";
import { periodToSince, msUntilCutoffChange, type Period } from "@/lib/telemetryPeriod";

/**
 * Fire just *after* the boundary. A timer that lands a millisecond early would
 * recompute the same cutoff it already had, produce an identical string, and
 * skip the refetch entirely until the next one.
 */
const BOUNDARY_MARGIN_MS = 1_000;

/**
 * The Telemetry section's cutoff, as an ISO string that actually advances.
 *
 * `periodToSince(period)` evaluated in a render body is stable across renders —
 * which is the point, since an unstable value re-fires every card's fetch — but
 * stability alone means a page left mounted across an hour boundary keeps its
 * old URLs and old data forever, because React does not re-render in response
 * to wall-clock time and nothing here polls. The code claimed an hourly
 * advancement that could only happen if some unrelated state changed first
 * (Codex review of #402).
 *
 * So: recompute on period change, and schedule a recompute at each boundary.
 * All six cards share the returned string, so one state update moves them
 * together rather than letting them drift apart — the coordination this whole
 * section exists to provide.
 *
 * Rescheduled per fire rather than `setInterval` so drift cannot accumulate and
 * so a device waking from sleep re-aligns to the real next boundary instead of
 * an hour after it happened to resume.
 */
export function useTelemetrySince(period: Period): string {
  const [since, setSince] = useState(() => periodToSince(period));

  useEffect(() => {
    // Covers the period changing, and re-syncs on remount. Setting the value it
    // already holds is a no-op — React bails out on Object.is equality.
    setSince(periodToSince(period));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      // Per period, because the cutoffs move on different clocks: the rolling
      // windows on the epoch hour, `today` at local midnight, `all` never.
      const delay = msUntilCutoffChange(period);
      if (delay === null) return; // `all` — epoch 0 forever, nothing to wake for.
      timer = setTimeout(() => {
        setSince(periodToSince(period));
        schedule();
      }, delay + BOUNDARY_MARGIN_MS);
    };
    schedule();

    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, [period]);

  return since;
}
