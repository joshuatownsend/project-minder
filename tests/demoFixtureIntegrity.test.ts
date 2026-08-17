/**
 * Cross-fixture referential integrity.
 *
 * Codex, PR #455 round 3: `demoPlans()` shipped `relatedSessionIds` as invented
 * UUIDs while `demoSessionsList()` uses `demo-<project>-<n>` ids, so every
 * "Related sessions" link in demo mode pointed at a session that does not
 * exist. It did not 404 — `demoSessionDetail()` falls back to the freshest
 * seed when nothing matches, so each link opened the *same* unrelated Aurora
 * session while claiming to be the related one.
 *
 * That is the failure mode demo mode exists to avoid: not a leak, but a screen
 * that looks right and is wrong, which is worse in a screenshot than an
 * obviously-empty one. A fixture referencing another fixture is a foreign key
 * with no database to enforce it, so it is enforced here instead.
 */

import { describe, it, expect } from "vitest";
import { demoPlans } from "@/lib/demo/plans";
import { demoSessionsList, demoSessionDetail } from "@/lib/demo/sessions";

const NOW = Date.UTC(2026, 7, 17);

describe("demo fixtures reference each other coherently", () => {
  it("every plan's related sessions exist in the session fixtures", () => {
    const known = new Set(demoSessionsList(NOW).sessions.map((s) => s.sessionId));
    const dangling = demoPlans(NOW).flatMap((p) =>
      p.relatedSessionIds.filter((id) => !known.has(id)).map((id) => `${p.slug} -> ${id}`)
    );

    expect(dangling).toEqual([]);
  });

  // The stronger assertion: resolving the link returns THAT session, not the
  // fallback. A set-membership check alone would still pass if the detail
  // lookup keyed on something else.
  it("resolves each related link to the session it names", () => {
    for (const plan of demoPlans(NOW)) {
      for (const id of plan.relatedSessionIds) {
        const { detail } = demoSessionDetail(id, NOW);
        expect(detail).not.toBeNull();
        expect(detail?.sessionId).toBe(id);
      }
    }
  });

  // Guards the test itself: if no plan carried a related session, both
  // assertions above would pass vacuously.
  it("some plan actually carries a related session", () => {
    expect(demoPlans(NOW).flatMap((p) => p.relatedSessionIds).length).toBeGreaterThan(0);
  });
});
