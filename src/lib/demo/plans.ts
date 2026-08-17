import type { PlanEntry } from "@/lib/types";

/**
 * Synthetic `~/.claude/plans/` catalog for demo mode.
 *
 * Plan files are among the most revealing things on the machine — titles alone
 * describe what the user is building, and the bodies more so. `/api/plans` and
 * `/api/plans/[slug]` both read the real directory with no guard.
 *
 * The two routes need separate entry points because the detail route does not
 * go through `scanClaudePlans()` — it opens `<slug>.md` directly — so guarding
 * the scanner alone would have closed the list and left the detail wide open.
 */
interface PlanSeed {
  slug: string;
  title: string;
  tags: string[];
  daysAgo: number;
  sessionIds: string[];
  body: string;
}

const SEEDS: PlanSeed[] = [
  {
    slug: "checkout-abandonment-recovery",
    title: "Checkout abandonment recovery",
    tags: ["aurora-commerce", "growth"],
    daysAgo: 2,
    sessionIds: ["demo-aurora-commerce-1"],
    body: `# Checkout abandonment recovery

Recover the ~18% of carts that stall at the payment step.

## Decisions
- Email at +1h and +24h; no third touch (measured fatigue past two).
- Reuse the existing job runner rather than adding a scheduler.

## Phases
1. Instrument the drop-off with a single event, verify it against the funnel.
2. Draft the two emails behind a flag, off by default.
3. Ship to 10% and hold for a week before widening.
`,
  },
  {
    slug: "ledger-double-entry-migration",
    title: "Ledger: migrate to double-entry",
    tags: ["ledger-api", "data", "migration"],
    daysAgo: 6,
    sessionIds: ["demo-ledger-api-1", "demo-ledger-api-2"],
    body: `# Ledger: migrate to double-entry

The single-entry table cannot express reversals without a synthetic row, and
reconciliation has quietly depended on that shape for two years.

## Constraints
- No downtime; the migration runs alongside the old table.
- Every historical row must round-trip, or the cutover does not happen.

## Steps
1. Add the paired-entry table and dual-write.
2. Backfill, then diff the two representations nightly for a week.
3. Flip reads. Keep dual-write for one release, then drop.
`,
  },
  {
    slug: "quill-editor-collaboration",
    title: "Quill: real-time collaborative editing",
    tags: ["quill-cms", "spike"],
    daysAgo: 11,
    sessionIds: [],
    body: `# Quill: real-time collaborative editing

Spike, not a commitment. Question: can we get presence + concurrent edits
without adopting a full CRDT library?

## Findings so far
- Operational transform is enough for the block model we already have.
- Presence is the easy half; conflict resolution on block *moves* is not.

## Open
- Whether offline editing is in scope at all. Probably not for v1.
`,
  },
  {
    slug: "atlas-cli-plugin-api",
    title: "Atlas CLI plugin API",
    tags: ["atlas-cli", "api-design"],
    daysAgo: 19,
    sessionIds: ["demo-atlas-cli-1"],
    body: `# Atlas CLI plugin API

Third parties want to add commands. The shape we pick is very hard to change
later, so this is worth getting right before anyone depends on it.

## Rejected
- Config-file registration: no way to ship logic.
- Arbitrary shell hooks: unbounded blast radius, impossible to sandbox.

## Chosen
A declarative manifest plus one entry module, loaded in-process, with the
command surface validated at load rather than at first use.
`,
  },
];

const DAY = 86_400_000;

function toEntry(seed: PlanSeed, nowMs: number): PlanEntry {
  return {
    slug: seed.slug,
    // Synthetic home, matching the shape the real scanner emits.
    path: `C:\\Users\\demo\\.claude\\plans\\${seed.slug}.md`,
    title: seed.title,
    tags: seed.tags,
    relatedSessionIds: seed.sessionIds,
    mtime: new Date(nowMs - seed.daysAgo * DAY).toISOString(),
    sizeBytes: seed.body.length,
  };
}

/** Catalog rows, newest first — the `/api/plans` list shape. */
export function demoPlans(nowMs: number): PlanEntry[] {
  return SEEDS.map((s) => toEntry(s, nowMs)).sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/** One plan with its body — the `/api/plans/[slug]` detail shape. Null when the
 *  slug is not one of the fixtures, so the route still 404s honestly. */
export function demoPlanDetail(
  slug: string,
  nowMs: number
): (PlanEntry & { body: string }) | null {
  const seed = SEEDS.find((s) => s.slug === slug);
  if (!seed) return null;
  return { ...toEntry(seed, nowMs), body: seed.body };
}
