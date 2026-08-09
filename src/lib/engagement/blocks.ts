import type { AttendedBlock, EngagementConfig, EngagementEvent } from "./types";

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
 *   blockEnd  = min(humanTs, blockEnd + credit)
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
 * ## Why the cap, and why `min(humanTs, ...)`
 *
 * A prompt sent 10 seconds after a 4-hour run proves the person came back, not
 * that they sat through it — `runCap` bounds that credit. The outer `min`
 * clamps credited time to real elapsed time, so a block can never bill more
 * wall clock than actually passed. Without it the two terms could double-count
 * a gap that contained an idle stretch before the agent started.
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
  let end = start;
  let prompts = isPresenceOnly?.(humanIdx[0]) ? 0 : 1;

  const close = () => {
    blocks.push({ start, end: end + tailCreditMs, promptCount: prompts });
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
      end = Math.min(ts, end + credit);
      if (!isPresenceOnly?.(i)) prompts++;
    } else {
      close();
      start = ts;
      end = ts;
      prompts = isPresenceOnly?.(i) ? 0 : 1;
    }
  }
  close();
  return blocks;
}

/** Total credited hours in a block list. */
export function blockHours(blocks: AttendedBlock[]): number {
  return blocks.reduce((sum, b) => sum + Math.max(0, b.end - b.start), 0) / 3_600_000;
}
