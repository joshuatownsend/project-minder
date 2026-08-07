/**
 * Presentation rules for the denial × task-outcome cross.
 *
 * Extracted from the card because the interesting part is not the arithmetic —
 * it is deciding when there is nothing to say. `getDenialBreakdown` leaves
 * `verifiedTasks` undefined when no denied turn also recorded a task outcome,
 * and on a typical index that is *every* kind: outcomes are written for well
 * under 1% of turns, denials are rare, and the two rarely coincide. A column
 * that renders "—" on every row implies a measurement in progress; one absent
 * column plus a single footnote says the true thing once.
 */

/** The row shape this module needs — a structural subset of `DenialKindRow`. */
export interface DenialOutcomeCounts {
  verifiedTasks?: number;
  oneShotTasks?: number;
}

export interface DenialRateDisplay {
  /** Formatted figure for the row, e.g. `"67% 1st-pass"`. */
  text: string;
  /** Fraction in [0,1], for callers that want to colour by threshold. */
  rate: number;
  /** Denominator — drives the small-sample badge. */
  sample: number;
  /** Hover text naming the counts the percentage came from. */
  title: string;
}

/**
 * The per-row figure, or `null` when this kind has no measured outcome.
 *
 * `null` means unmeasured, and unmeasured is not zero — a kind whose denied
 * turns never recorded an outcome is not a kind that always failed. Callers
 * must render nothing rather than substituting a default.
 */
export function describeDenialRate(row: DenialOutcomeCounts): DenialRateDisplay | null {
  const { verifiedTasks, oneShotTasks } = row;

  // Explicit rather than truthiness: `0` and `undefined` are both falsy here
  // but mean different things, and only one of them should ever occur (SQL
  // GROUP BY cannot emit a row with COUNT(*) = 0). Treating a hypothetical
  // zero denominator as "no sample" is the safe reading — the alternative
  // divides by zero and renders NaN%.
  if (typeof verifiedTasks !== "number" || verifiedTasks <= 0) return null;

  // A denominator without a numerator is not a 0% pass rate, it is a row we
  // cannot interpret. Refuse it rather than reporting the most alarming
  // possible reading of missing data.
  if (typeof oneShotTasks !== "number") return null;

  const rate = oneShotTasks / verifiedTasks;
  return {
    text: `${Math.round(rate * 100)}% 1st-pass`,
    rate,
    sample: verifiedTasks,
    title: `${oneShotTasks} of ${verifiedTasks} ${
      verifiedTasks === 1 ? "task" : "tasks"
    } started on a denied turn passed first time`,
  };
}

/**
 * True when at least one kind carries a measurable outcome.
 *
 * Drives the all-or-nothing choice: show the column, or drop it and explain
 * its absence once at the foot of the card.
 */
export function anyDenialOutcomeMeasured(rows: readonly DenialOutcomeCounts[]): boolean {
  return rows.some((r) => describeDenialRate(r) !== null);
}

/**
 * Why the column is missing, in terms a reader can act on.
 *
 * Deliberately qualitative: the exact coverage ratio lives in SQL and is not
 * sent to the client, and inventing a number here would be worse than omitting
 * one.
 */
export const NO_OUTCOME_FOOTNOTE =
  "First-pass success is unknown for every kind here — none of these denied turns also recorded a task outcome. That is a gap in the cross, not a score of zero.";
