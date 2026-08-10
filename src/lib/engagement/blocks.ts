import type { AttendedBlock, EngagementConfig, EngagementEvent, Interval } from "./types";
import { mergeIntervals, intervalHours } from "./intervals";

/**
 * Turn a project's event stream into blocks of credited human attention.
 *
 * ## The formula (this is the invoice, so it is stated once, here)
 *
 * Walk the human prompts in order. For each consecutive pair, look at the
 * agent events that fall between them and split the gap in two:
 *
 * ```
 *   agentBusy = lastAgentTs - prevHumanTs      (0 when the gap has no agent events)
 *   quiet     = humanTs     - lastAgentTs      (falls back to the full gap when none)
 *
 *   attended  = quiet <= responseThreshold
 *   credit    = min(agentBusy, runCap) + quiet
 *   interval  = [humanTs - credit, humanTs]
 * ```
 *
 * If `attended` the block absorbs `credit` and continues; otherwise the block
 * closes (plus `tailCredit`) and a new one opens at this prompt.
 *
 * `agentBusy` is measured from the **previous human prompt**, not from the
 * first agent event in the gap. Measuring first-to-last agent event returns
 * zero whenever the gap holds a single assistant turn — the common shape of a
 * long thinking/tool response — which silently dropped genuinely supervised
 * minutes. `agentBusy + quiet` now telescopes to exactly the prompt-to-prompt
 * gap, so an attended gap under the cap credits the full elapsed time and
 * nothing is lost to the seam.
 *
 * ## Why `quiet`, not the raw prompt-to-prompt gap
 *
 * The obvious metric — "more than N minutes between my messages means I was
 * idle" — is wrong in the one case that matters most. Supervising a 40-minute
 * agent run produces a 40-minute gap with a human watching the whole time; a
 * 2-minute run the person walked away from produces a 3-hour gap. Raw gap
 * cannot tell those apart. `quiet` can: it measures how fast the human reacted
 * once the agent actually stopped, which is precisely a test of attendance.
 *
 * ## Why the cap, and why credit is anchored to `humanTs`
 *
 * A prompt sent 10 seconds after a 4-hour run proves the person came back, not
 * that they sat through it — `runCap` bounds that credit. Where the surviving
 * credit *sits* is a second decision: it is anchored to end at the reply, so a
 * capped run credits its final 30 minutes rather than its first. That matches
 * what the evidence supports — someone who answered promptly was there shortly
 * before answering — and nothing supports the opening minutes over the closing
 * ones.
 *
 * Anchoring is not cosmetic. An earlier version accumulated credit forward
 * from the block's start (`end = min(humanTs, end + credit)`), so after any
 * capped gap every later interval was recorded earlier than it happened. Block
 * totals stayed correct, which is why it looked fine — but local-day bucketing
 * and cross-project overlap allocation both read real instants, so a capped
 * four-hour run followed by an evening exchange could book that exchange on
 * the wrong calendar day, or miss an overlap with another project entirely.
 * Credited time now never leaves the gap it was earned in.
 *
 * **This branch is the one that matters.** An earlier draft credited a flat
 * `runCap` and split the block whenever `agentBusy > runCap`; this one credits
 * `min(agentBusy, runCap)` and keeps the block open. On the same corpus and
 * the same thresholds the two differ by 10.5 h over five weeks (80.1 vs 69.6)
 * — a 15 % swing on an invoice from an undocumented choice. Hence: one
 * formula, written down, echoed back by the report.
 *
 * ## Unattended gaps credit nothing but the tail
 *
 * When `quiet` exceeds the threshold, the agent work inside that gap earns
 * **no** credit — only the closing `tailCredit`. Fire off a prompt at 17:00,
 * let a 25-minute run finish unwatched, come back at 09:00: that books
 * `tailCredit`, not 25 minutes.
 *
 * This is deliberately the conservative reading. Crediting
 * `min(agentBusy, responseThreshold)` there is defensible too ("I supervised
 * until I stepped away") and would raise the total, but it bills supervision
 * nobody can evidence. On a client invoice, under-billing is a smaller
 * professional risk than over-billing — and separating watched work from
 * fire-and-forget work is the entire point of the report.
 */
export function buildAttendedBlocks(
  events: EngagementEvent[],
  config: EngagementConfig,
  /** Predicate marking presence-only events (interrupts) that keep a block
   *  alive without counting as prompts. Index-aligned with `events`. */
  isPresenceOnly?: (index: number) => boolean,
): AttendedBlock[] {
  const { responseThresholdMs, runCapMs, tailCreditMs } = config;

  // Chronological order is a precondition of the whole walk — a single
  // out-of-order row would compute a negative `quiet` and silently close a
  // block. Sort defensively rather than trusting the caller's ORDER BY.
  const ev = [...events].sort((a, b) => a.ts - b.ts);

  const humanIdx: number[] = [];
  for (let i = 0; i < ev.length; i++) if (ev[i].kind === "human") humanIdx.push(i);
  if (humanIdx.length === 0) return [];

  const blocks: AttendedBlock[] = [];
  let start = ev[humanIdx[0]].ts;
  let lastPromptTs = start;
  let promptTimes: number[] = isPresenceOnly?.(humanIdx[0]) ? [] : [start];
  let intervals: Interval[] = [];

  const close = () => {
    // Tail credit hangs off the last prompt, on the real timeline like every
    // other interval. Zero-length when tailCreditMs is 0, and `mergeIntervals`
    // drops it — a lone prompt with no tail credit bills nothing, which is the
    // same answer the accumulate-forward version gave.
    const withTail = [...intervals, { start: lastPromptTs, end: lastPromptTs + tailCreditMs }];
    blocks.push({
      start,
      end: lastPromptTs + tailCreditMs,
      intervals: mergeIntervals(withTail),
      promptTimes,
      promptCount: promptTimes.length,
    });
  };

  for (let k = 1; k < humanIdx.length; k++) {
    const i = humanIdx[k];
    const ts = ev[i].ts;

    // Scan back to the previous human event for the newest agent event in the
    // gap. Walking backwards, that is the first one we meet.
    let lastAgent: number | null = null;
    for (let j = i - 1; j >= 0 && ev[j].kind !== "human"; j--) {
      lastAgent = ev[j].ts;
      break;
    }

    const prevHumanTs = ev[humanIdx[k - 1]].ts;
    const quiet = lastAgent !== null ? ts - lastAgent : ts - prevHumanTs;
    const agentBusy = lastAgent !== null ? Math.max(0, lastAgent - prevHumanTs) : 0;

    if (quiet <= responseThresholdMs) {
      const credit = Math.min(agentBusy, runCapMs) + quiet;
      // `credit <= agentBusy + quiet == ts - prevHumanTs`, so this never
      // reaches back past the previous prompt; the max is a guard, not a clamp
      // that changes any real result.
      intervals.push({ start: Math.max(prevHumanTs, ts - credit), end: ts });
      lastPromptTs = ts;
      if (!isPresenceOnly?.(i)) promptTimes.push(ts);
    } else {
      close();
      start = ts;
      lastPromptTs = ts;
      intervals = [];
      promptTimes = isPresenceOnly?.(i) ? [] : [ts];
    }
  }
  close();
  return blocks;
}

/** Total credited hours in a block list — the sum of its intervals, never
 *  `end - start`, which overstates any block containing a capped gap. */
export function blockHours(blocks: AttendedBlock[]): number {
  return blocks.reduce((sum, b) => sum + intervalHours(b.intervals), 0);
}

/** Every credited interval across a block list, flattened. */
export function blockIntervals(blocks: AttendedBlock[]): Interval[] {
  return blocks.flatMap((b) => b.intervals);
}
