import type { Interval } from "./types";

/**
 * Interval primitives shared by the block builder and the allocator.
 *
 * These live in their own module rather than in `allocate.ts` because
 * `blocks.ts` needs `mergeIntervals` to fold its tail credit in, and having
 * the block builder import from the allocator would invert the natural
 * dependency (blocks are the allocator's *input*).
 */

/** Collapse overlapping/touching intervals into a minimal ascending set. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

export function intervalHours(intervals: Interval[]): number {
  return intervals.reduce((s, i) => s + Math.max(0, i.end - i.start), 0) / 3_600_000;
}

/**
 * Drop everything before `from`, trimming the interval that straddles it.
 *
 * Used to keep a report inside its requested period after the query has
 * deliberately over-fetched. A block whose attended gap starts before the
 * period boundary has to be *reconstructed* with its preceding prompt — the
 * alternative is that the gap is unrecognizable and its credited time silently
 * vanishes — and then clipped, so the over-fetch never leaks into the total.
 */
export function clipFrom(intervals: Interval[], from: number): Interval[] {
  return clipRange(intervals, from, Number.POSITIVE_INFINITY);
}

/**
 * Restrict intervals to `[from, to]`, dropping and trimming as needed.
 *
 * The upper bound is not symmetry for its own sake. Tail credit hangs off the
 * last prompt, so a prompt at 23:59 with a three-minute tail would otherwise
 * credit time in the *future* — and, on a Today report, mint a row for
 * tomorrow. Clipping at the report's evaluation instant keeps credited time
 * inside the window that actually happened.
 */
export function clipRange(intervals: Interval[], from: number, to: number): Interval[] {
  const out: Interval[] = [];
  for (const iv of intervals) {
    const start = Math.max(iv.start, from);
    const end = Math.min(iv.end, to);
    if (end > start) out.push({ start, end });
  }
  return out;
}
