/** Hundredths of an hour — the precision a timecard is filed in. */
const UNITS = 100;

export function round2(n: number): number {
  return Math.round(n * UNITS) / UNITS;
}

/**
 * Round a set of shares to 2dp so they sum **exactly** to `total`.
 *
 * Rounding each share independently does not reconcile: three equal shares of
 * a 5-minute day are 0.0278 h each, which round to 0.03 and display as 0.09
 * against a day total of 0.08. The report states that per-project rows sum to
 * the day's total, and the CSV is filed against that promise — so the rounding
 * has to be apportioned rather than applied pointwise.
 *
 * Largest-remainder (Hamilton) apportionment: floor every share, then hand the
 * leftover hundredths to whichever shares lost the most in the floor. The
 * remainder is always in `[0, n]` — `sum(floors)` is an integer no greater
 * than `sum(raw)`, hence no greater than `round(sum(raw))` — so only the
 * hand-out direction exists and there is no take-back loop to get wrong.
 *
 * Ties break toward the earlier index, which is stable rather than fair; with
 * shares this small the alternative is a cent moving between rows on reload.
 */
export function apportionRounded(shares: number[], total: number): number[] {
  if (shares.length === 0) return [];
  const targetUnits = Math.round(total * UNITS);
  const raw = shares.map((s) => s * UNITS);
  const floors = raw.map((v) => Math.floor(v));
  const assigned = floors.reduce((a, b) => a + b, 0);

  let remainder = targetUnits - assigned;
  if (remainder > 0) {
    const byFraction = raw
      .map((v, i) => ({ i, frac: v - Math.floor(v) }))
      .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
    for (let k = 0; k < byFraction.length && remainder > 0; k++, remainder--) {
      floors[byFraction[k].i] += 1;
    }
  }
  return floors.map((u) => u / UNITS);
}
