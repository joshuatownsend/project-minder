/**
 * Human-engagement (timecard) types.
 *
 * The question this module answers: **of the wall-clock time a Claude Code
 * transcript spans, how much did a human actually spend attending to it?**
 * That number is what goes on a client invoice; total session span is not,
 * because an agent that ran unattended for two hours produces the same
 * transcript span as two hours of supervised pair-work.
 *
 * See `blocks.ts` for the credit formula and `config.ts` for where the default
 * thresholds come from (they were measured, not guessed).
 */

/** One transcript event, reduced to the only two facts the model needs. */
export interface EngagementEvent {
  /** Epoch ms. */
  ts: number;
  /**
   * `human` = a turn a person actually authored (typed prompt, `/slash`
   * command, or `!bash` input). `agent` = everything else: assistant turns,
   * tool results, and machine-injected user turns (hook output, task
   * notifications, compaction continuations).
   *
   * The split is the whole ballgame — see `classifier.ts`.
   */
  kind: "human" | "agent";
}

/** A half-open [start, end) span of credited human attention, in epoch ms. */
export interface AttendedBlock {
  start: number;
  end: number;
  /** Count of human prompts inside the block. Used for the audit trail. */
  promptCount: number;
}

/**
 * Tunable thresholds. Every one of these changes the invoice, so they are
 * explicit inputs rather than constants buried in the algorithm, and the
 * report echoes the values it was computed with.
 */
export interface EngagementConfig {
  /**
   * How long the agent may sit idle before the next human prompt and still
   * count as "the human was watching". This is the single most important
   * knob — it is the user's "idleness metric".
   */
  responseThresholdMs: number;
  /**
   * Maximum credit for one uninterrupted agent run inside an attended gap.
   * Bounds the "agent worked 4 hours, human replied in 10 seconds" case,
   * where a prompt reply proves the human came back but not that they sat
   * there the whole time.
   */
  runCapMs: number;
  /**
   * Flat credit added to the end of every block for the reading/verifying a
   * person does after the last prompt, which leaves no transcript trace.
   */
  tailCreditMs: number;
}

/** Per-project engagement over the report period. */
export interface ProjectEngagement {
  /** Encoded conversation-dir name, e.g. `C--dev-sales-dashboards`. */
  projectDirName: string;
  /** Route slug when resolvable, else null. */
  projectSlug: string | null;
  /** Hours of attended time attributed to this project alone. */
  rawHours: number;
  /**
   * Hours after de-overlapping concurrent projects (see `allocate.ts`).
   * These sum, across projects, exactly to the period's union hours — this
   * is the number that belongs on a timecard.
   */
  allocatedHours: number;
  /** Human prompts in the period. */
  promptCount: number;
  /** Distinct local days with any attended time. */
  activeDays: number;
}

/** One local calendar day — the unit a timecard is actually filed in. */
export interface EngagementDay {
  /** `YYYY-MM-DD` in the report's timezone, not UTC. */
  date: string;
  /** De-overlapped hours across all projects in scope that day. */
  totalHours: number;
  /** Per-project allocated hours for the day; sums to `totalHours`. */
  byProject: { projectDirName: string; hours: number }[];
}

export interface EngagementReport {
  period: string;
  /** IANA zone the local-day buckets were computed in. */
  timeZone: string;
  /** The exact thresholds this report was computed with. */
  config: EngagementConfig;
  /** Sum of `allocatedHours` — the billable total for the period. */
  totalHours: number;
  /** Sum of `rawHours`; exceeds `totalHours` when projects overlap. */
  rawHours: number;
  /** `rawHours - totalHours`: time that would be double-billed by a naive sum. */
  overlapHours: number;
  byProject: ProjectEngagement[];
  byDay: EngagementDay[];
  /** Sessions excluded as automated (`entrypoint` starts with `sdk-`). */
  excludedAutomatedSessions: number;
}
