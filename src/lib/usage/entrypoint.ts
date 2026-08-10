/**
 * Session entrypoint vocabulary (A3).
 *
 * **Why this file is not called `sessionKind.ts`.** The plan for this slice
 * assumed Claude Code's `sessionKind` carried an `interactive` / `attached` /
 * `unattended` split to segment on. It does not. A full-corpus scan on
 * 2026-08-05 — 3,685 transcripts, every `~/.claude/projects` session — found
 * `sessionKind` present on **5 sessions (0.1%)** and only ever valued `bg`.
 * It is a marker emitted for background runs, not an enum.
 *
 * `entrypoint` is the axis with real discriminating power, and the numbers
 * below are from the **index** (period=all, the panel's own population) rather
 * than a file walk — see the caveat at the end for why that distinction cost a
 * round of wrong documentation:
 *
 *     cli       1,301 sessions  41.0%   $15,882.85   95.8% of spend
 *     sdk-cli   1,535 sessions  48.3%      $428.50    2.6%
 *     sdk-py      291 sessions   9.2%      $128.87    0.8%
 *     unknown      50 sessions   1.6%      $139.19    0.8%
 *
 * The finding is the **inversion**: 57.5% of sessions are SDK-driven and they
 * account for 3.4% of the bill, while interactive sessions are 41% of sessions
 * and 95.8% of spend. Per session that is $12.21 against $0.28 — an
 * interactive session costs roughly **44x** an automated one. Either share
 * read alone produces a confident wrong answer about where the money goes,
 * which is why the panel refuses to show one without the other.
 *
 * `unknown` is NOT hypothetical padding: 50 real sessions land there. An
 * earlier draft of this file asserted 100% coverage on the strength of a file
 * probe and was wrong.
 *
 * Two cautions, both learned by getting it wrong first:
 *
 *   - `sdk-py` appeared in **none** of a newest-400-file sample and surfaced
 *     only on the full-corpus pass. Enumerate this vocabulary over the whole
 *     history, never the recent head.
 *   - A walk of the per-project transcript files does NOT see the ~1,256
 *     subagent transcripts under `<session>/subagents/` that the indexer also
 *     ingests, and those are overwhelmingly `cli` (a subagent inherits its
 *     parent's entrypoint). Measured that way the split reads as 88% sdk-cli /
 *     4.5% cli — nearly the opposite of what the panel shows. **Quote figures
 *     from the index, never from a file probe.**
 *
 * Re-measured 2026-08-10 on a grown corpus (6,024 sessions): cli 1,448 at
 * $13.43/session against sdk-cli 4,156 at $0.22 — the gap widened from 44x to
 * **61x**, and the inversion sharpened to 69% of sessions producing 4% of the
 * spend. The figures above are kept as the dated original rather than
 * overwritten; what matters is that the direction has held across both
 * measurements, not the exact multiple on any one day.
 */

/**
 * Bucket for a session with no recorded entrypoint.
 *
 * Real, not defensive: **50 indexed sessions** land here. A file probe had
 * suggested 100% coverage, which is how this bucket came close to being
 * written off as padding — the index disagreed. It also covers the window
 * before a re-index populates `sessions.entrypoint`, when every row reads
 * NULL and the panel's whole population is this bucket.
 */
export const UNKNOWN_ENTRYPOINT = "unknown";

/**
 * Display order. Deliberately fixed rather than cost-sorted.
 *
 * The comparison this panel exists to support is "how does supervised work
 * differ from automated work", which requires the two groups to stay in the
 * same places between periods. Sorting by cost would let a heavy month of
 * batch runs swap the rows and destroy the visual comparison — the same
 * reasoning that keeps `byEffort` on its ordinal scale.
 *
 * Human-driven first, then the SDK variants, unknown last.
 */
export const ENTRYPOINT_ORDER = ["cli", "sdk-cli", "sdk-py", UNKNOWN_ENTRYPOINT] as const;

const ENTRYPOINT_RANK = new Map<string, number>(ENTRYPOINT_ORDER.map((e, i) => [e, i]));

/**
 * Human-facing labels. The raw values are jargon (`sdk-py` tells you nothing
 * about supervision), and this panel's entire claim is about who was watching.
 */
const ENTRYPOINT_LABELS: Record<string, string> = {
  "cli": "Interactive",
  "sdk-cli": "SDK (CLI)",
  "sdk-py": "SDK (Python)",
  [UNKNOWN_ENTRYPOINT]: "Unknown",
};

export function entrypointLabel(entrypoint: string): string {
  return ENTRYPOINT_LABELS[entrypoint] ?? entrypoint;
}

/**
 * Map a raw `sessions.entrypoint` value to its bucket key. Absent, null and
 * empty all collapse to {@link UNKNOWN_ENTRYPOINT}; any unrecognized non-empty
 * value passes through verbatim so a future Claude Code entrypoint appears as
 * its own row rather than vanishing into unknown.
 *
 * The empty-string case is not theoretical padding: the equivalent gap in the
 * effort code shipped, because `effortBucket("")` returned `unknown` while the
 * SQL only `COALESCE`d NULL, so the two backends disagreed. Both sides of this
 * one normalize empty and NULL identically — see `queryByEntrypoint`.
 */
export function entrypointBucket(entrypoint: string | null | undefined): string {
  return entrypoint ? entrypoint : UNKNOWN_ENTRYPOINT;
}

/**
 * Sort comparator for entrypoint keys. Known values follow
 * {@link ENTRYPOINT_ORDER}; unrecognized ones sort after `unknown`,
 * alphabetically, so their order is at least stable.
 */
export function compareEntrypoint(a: string, b: string): number {
  const ra = ENTRYPOINT_RANK.get(a) ?? ENTRYPOINT_ORDER.length;
  const rb = ENTRYPOINT_RANK.get(b) ?? ENTRYPOINT_ORDER.length;
  return ra === rb ? a.localeCompare(b) : ra - rb;
}

/**
 * Was this session driven by a program rather than a person at a terminal?
 *
 * Keyed on the `sdk-` prefix rather than an explicit list, so a future
 * `sdk-go` is classified correctly the first time it appears instead of being
 * silently counted as supervised — the failure direction that matters, since
 * mislabelling automated work as human inflates every "what did I do today"
 * figure.
 *
 * An **unknown** entrypoint is deliberately NOT automated. Absence is not
 * evidence, and guessing here would put unclassifiable sessions into whichever
 * bucket the guess favours rather than leaving them visibly unclassified.
 */
export function isAutomatedEntrypoint(entrypoint: string): boolean {
  return entrypoint.startsWith("sdk-");
}

/**
 * The `bg` marker from `sessions.session_kind`, kept as a **flag on top of**
 * the entrypoint rather than a peer bucket.
 *
 * It is orthogonal: all 5 observed `bg` sessions were `cli`, so folding it
 * into the entrypoint axis would have moved interactive-but-backgrounded runs
 * out of the `cli` row and quietly changed what that row means. As a flag it
 * answers a different question — "was anyone watching this one?" — without
 * disturbing the primary split.
 */
export const BACKGROUND_SESSION_KIND = "bg";

export function isBackgroundSession(sessionKind: string | null | undefined): boolean {
  return sessionKind === BACKGROUND_SESSION_KIND;
}
