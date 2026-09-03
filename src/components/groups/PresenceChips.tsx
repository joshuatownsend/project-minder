"use client";

/**
 * Divergence flags for the group page. Every merged item from
 * `aggregateGroup()` carries `presentIn` / `completedIn` / `statusIn` /
 * `editedIn`; these chips turn that into "only in C:", "done in WSL Ubuntu",
 * "edited in D:". They use the dashboard's amber attention tokens — a
 * divergence is something the user may need to act on — and stay silent
 * when every location agrees, so a group whose copies match reads exactly
 * like a single project.
 */

/** Member slug → short location label (`locationLabels()` output keyed by slug). */
export type Labels = Record<string, string>;

const CHIP: React.CSSProperties = {
  fontSize: "0.6rem",
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  letterSpacing: "0.04em",
  padding: "1px 5px",
  borderRadius: "3px",
  whiteSpace: "nowrap",
  display: "inline-block",
};

export function DivergenceChip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      style={{
        ...CHIP,
        color: "var(--accent)",
        background: "var(--accent-bg)",
        border: "1px solid var(--accent-border)",
      }}
    >
      {children}
    </span>
  );
}

export function LocationChip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span title={title} style={{ ...CHIP, color: "var(--info)", background: "var(--info-bg)" }}>
      {children}
    </span>
  );
}

function names(slugs: readonly string[], labels: Labels): string {
  return slugs.map((s) => labels[s] ?? s).join(", ");
}

/**
 * Chips for one merged item.
 *
 * - present in a strict subset → "only in X" (or "not in Y" when that is the
 *   shorter list);
 * - done in some but not all locations that have it → "done in X";
 * - a per-location status map with more than one value → one chip per value;
 * - edited in some location → "edited in X".
 */
export function PresenceChips({
  presentIn,
  memberSlugs,
  labels,
  completedIn,
  doneWord = "done",
  statusIn,
  editedIn,
}: {
  presentIn: readonly string[];
  memberSlugs: readonly string[];
  labels: Labels;
  completedIn?: readonly string[];
  doneWord?: string;
  statusIn?: Record<string, string>;
  editedIn?: readonly string[];
}) {
  const chips: React.ReactNode[] = [];
  const missing = memberSlugs.filter((s) => !presentIn.includes(s));
  if (missing.length > 0) {
    chips.push(
      missing.length < presentIn.length ? (
        <DivergenceChip key="missing" title={`Not in ${names(missing, labels)}`}>
          not in {names(missing, labels)}
        </DivergenceChip>
      ) : (
        <DivergenceChip key="only" title={`Only in ${names(presentIn, labels)}`}>
          only in {names(presentIn, labels)}
        </DivergenceChip>
      )
    );
  }
  if (completedIn && completedIn.length > 0 && completedIn.length < presentIn.length) {
    const open = presentIn.filter((s) => !completedIn.includes(s));
    chips.push(
      <DivergenceChip key="done" title={`${doneWord} in ${names(completedIn, labels)}; open in ${names(open, labels)}`}>
        {doneWord} in {names(completedIn, labels)}
      </DivergenceChip>
    );
  }
  if (statusIn) {
    const values = new Set(Object.values(statusIn));
    if (values.size > 1) {
      for (const [slug, status] of Object.entries(statusIn)) {
        chips.push(
          <DivergenceChip key={`status:${slug}`}>
            {labels[slug] ?? slug}: {status}
          </DivergenceChip>
        );
      }
    }
  }
  if (editedIn && editedIn.length > 0) {
    chips.push(
      <DivergenceChip key="edited" title={`Differs in ${names(editedIn, labels)}`}>
        edited in {names(editedIn, labels)}
      </DivergenceChip>
    );
  }
  if (chips.length === 0) return null;
  return <span style={{ display: "inline-flex", gap: "4px", flexWrap: "wrap" }}>{chips}</span>;
}
