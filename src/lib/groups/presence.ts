/**
 * Divergence-flag selection for a merged group item — the pure half of
 * `PresenceChips`. Every item from `aggregateGroup()` carries `presentIn` /
 * `completedIn` / `statusIn` / `editedIn`; this decides which chips those
 * earn, so the branch logic is testable without rendering.
 *
 * Client-safe like the rest of `src/lib/groups/`.
 */

/** Member slug → short location label (`locationLabels()` output keyed by slug). */
export type Labels = Record<string, string>;

export interface PresenceFlag {
  /** Stable key for React and for tests. */
  key: string;
  text: string;
  /** Longer explanation for the `title` attribute, when the text is elided. */
  title?: string;
}

export interface PresenceInput {
  presentIn: readonly string[];
  memberSlugs: readonly string[];
  labels: Labels;
  /** Locations where the item is checked off / done. */
  completedIn?: readonly string[];
  /** Verb for a partial `completedIn` — "done" by default. */
  doneWord?: string;
  /** Per-location status; a chip per location when the values disagree. */
  statusIn?: Record<string, string>;
  /** Locations whose copy differs from the headline in a non-status field. */
  editedIn?: readonly string[];
}

function names(slugs: readonly string[], labels: Labels): string {
  return slugs.map((s) => labels[s] ?? s).join(", ");
}

/**
 * - nothing present anywhere → no flags (agreement, not divergence);
 * - present in a strict subset → `only in X`, or `not in Y` when that is the
 *   shorter list;
 * - done in some but not all locations that have it → `done in X`;
 * - a status map with more than one distinct value → one chip per location;
 * - edited somewhere → `edited in X`.
 */
export function presenceFlags(input: PresenceInput): PresenceFlag[] {
  const { presentIn, memberSlugs, labels, completedIn, doneWord = "done", statusIn, editedIn } = input;
  if (presentIn.length === 0) return [];
  const flags: PresenceFlag[] = [];

  const missing = memberSlugs.filter((s) => !presentIn.includes(s));
  if (missing.length > 0) {
    flags.push(
      missing.length < presentIn.length
        ? { key: "missing", text: `not in ${names(missing, labels)}` }
        : { key: "only", text: `only in ${names(presentIn, labels)}` }
    );
  }

  if (completedIn && completedIn.length > 0 && completedIn.length < presentIn.length) {
    const open = presentIn.filter((s) => !completedIn.includes(s));
    flags.push({
      key: "done",
      text: `${doneWord} in ${names(completedIn, labels)}`,
      title: `${doneWord} in ${names(completedIn, labels)}; open in ${names(open, labels)}`,
    });
  }

  if (statusIn && new Set(Object.values(statusIn)).size > 1) {
    for (const [slug, status] of Object.entries(statusIn)) {
      flags.push({ key: `status:${slug}`, text: `${labels[slug] ?? slug} → ${status}` });
    }
  }

  if (editedIn && editedIn.length > 0) {
    flags.push({ key: "edited", text: `edited in ${names(editedIn, labels)}`, title: `Differs in ${names(editedIn, labels)}` });
  }

  return flags;
}
