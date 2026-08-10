import { expect } from "vitest";

/**
 * Assert that a reconcile pass completed cleanly, at the setup line that ran
 * it rather than several assertions later.
 *
 * `reconcileAllSessions` does not throw on a per-file failure: it counts it in
 * `stats.errors` and carries on, and it clears the v3 readiness gate **only**
 * when that count is zero (src/lib/db/ingest.ts). While the gate is set, the
 * façade deliberately serves file-parse instead of the SQL aggregate — correct
 * for production, where a partially-reconciled index should not report
 * silently incomplete totals.
 *
 * In a test that intends to exercise the DB backend, though, that same
 * behaviour is a trap: the setup quietly produces the *other* backend, and the
 * failure surfaces much later as a backend-parity divergence with no hint that
 * a reconcile error caused it. That is #273 — a cluster of parity tests failing
 * on the Windows runner, passing on re-run, and reported as mismatched numbers
 * rather than as "the index was not ready".
 *
 * So every call site discarding these stats is asserting, implicitly and
 * invisibly, that reconcile never fails. Say it out loud instead.
 *
 * Checking `errors` is equivalent to checking the gate, and needs no db
 * handle — zero errors is precisely the condition under which the gate clears.
 */
export function assertReconcileClean<T extends { errors: number }>(stats: T): T {
  expect(
    stats.errors,
    "reconcileAllSessions reported per-file errors, so the v3 readiness gate " +
      "stayed set and DB-backed reads will silently fall back to file-parse. " +
      "Whatever this test asserts next is measuring the wrong backend (#273).",
  ).toBe(0);
  return stats;
}
