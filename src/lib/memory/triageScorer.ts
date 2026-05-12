import type { MemoryFileEntry } from "../types";

/**
 * Triage classification for one auto-scope memory file. The article's central
 * principle ("default-to-no-op writes; recommend, never auto-delete") shapes
 * the contract here: this module emits recommendations + reasons + a numeric
 * score, but never mutates anything on disk. The /memory/triage UI is what
 * the user clicks through to act on the recommendation.
 */
export type TriageRecommendation = "keep" | "archive" | "delete";

export interface TriageEntry {
  entry: MemoryFileEntry;
  recommendation: TriageRecommendation;
  /** 0-100. Used to sort within a recommendation group. Higher = more confident. */
  score: number;
  /** Human-readable signals that drove the recommendation (e.g. "Never read"). */
  reasons: string[];
  /** ISO timestamp; only present when the user has hit "Keep for N days". */
  suppressedUntil?: string;
}

export interface TriageThresholds {
  /** A never-read entry older than this is archive-eligible. */
  archiveAgeDays: number;
  /** An entry whose last read is older than this is archive-eligible. */
  archiveStaleReadDays: number;
}

/**
 * Default profile picked in the M.4 scope question. Strict / Aggressive
 * variants live in tests and could be exposed via `.minder.json` later if
 * the user wants to widen or narrow the funnel without a code change.
 */
export const MODERATE_THRESHOLDS: TriageThresholds = {
  archiveAgeDays: 60,
  archiveStaleReadDays: 90,
};

export interface ScoreInput {
  entries: MemoryFileEntry[];
  /** absPath -> ISO timestamp; entries with a future-dated value are hidden. */
  suppressUntil: Record<string, string>;
  /** Test seam. Defaults to Date.now(). */
  now?: number;
  thresholds?: TriageThresholds;
}

export interface TriageReport {
  /** Entries recommended for action (archive or delete), sorted high-confidence first. */
  candidates: TriageEntry[];
  /** Entries currently in a "Keep for N days" window; surfaced so the user can lift the hold. */
  suppressed: TriageEntry[];
  /** Total auto-scope entries inspected, including ones that scored as keep. */
  total: number;
  /** Sum of sizeBytes across candidates — surfaced in the banner as the cleanup payoff. */
  bytesRecoverable: number;
}

const DAY_MS = 24 * 60 * 60_000;

export function scoreTriage(input: ScoreInput): TriageReport {
  const thresholds = input.thresholds ?? MODERATE_THRESHOLDS;
  const now = input.now ?? Date.now();
  const archiveAgeMs = thresholds.archiveAgeDays * DAY_MS;
  const staleReadMs = thresholds.archiveStaleReadDays * DAY_MS;

  const candidates: TriageEntry[] = [];
  const suppressed: TriageEntry[] = [];
  let total = 0;
  let bytesRecoverable = 0;

  for (const entry of input.entries) {
    // Triage operates strictly on the agent's memory dir (auto scope). The
    // user's global CLAUDE.md and per-project CLAUDE.md are not move/delete
    // candidates — they're authored by the user, not the agent.
    if (entry.scope !== "auto") continue;
    // MEMORY.md is the index, not a leaf memory; archiving it would orphan
    // every body entry it points at.
    if (entry.displayName.toLowerCase() === "memory.md") continue;
    total++;

    const suppressIso = input.suppressUntil[entry.absPath];
    if (suppressIso) {
      const suppressMs = Date.parse(suppressIso);
      if (Number.isFinite(suppressMs) && suppressMs > now) {
        suppressed.push({
          entry,
          recommendation: "keep",
          score: 0,
          reasons: [`Suppressed until ${suppressIso.slice(0, 10)}`],
          suppressedUntil: suppressIso,
        });
        continue;
      }
    }

    const ageMs = now - entry.mtimeMs;
    const ageDays = Math.floor(ageMs / DAY_MS);
    const lastReadMs = entry.usage ? Date.parse(entry.usage.lastReadAt) : NaN;
    const sinceReadMs = Number.isFinite(lastReadMs) ? now - lastReadMs : null;
    const neverRead = !entry.usage || entry.usage.readCount === 0;
    const brokenRefs = entry.stale.brokenRefs.length;
    const brokenImports = entry.stale.brokenImports.length;
    const orphaned = entry.indexed === false;

    const reasons: string[] = [];
    let score = 0;

    if (neverRead) {
      reasons.push("Never read");
      score += 30;
    } else if (sinceReadMs !== null) {
      const sinceDays = Math.floor(sinceReadMs / DAY_MS);
      if (sinceDays >= thresholds.archiveStaleReadDays) {
        reasons.push(`Last read ${sinceDays}d ago`);
        score += 25;
      }
    }
    if (ageDays >= thresholds.archiveAgeDays) {
      reasons.push(`Age ${ageDays}d`);
      score += 15;
    }
    if (brokenRefs > 0) {
      reasons.push(`${brokenRefs} broken ref${brokenRefs === 1 ? "" : "s"}`);
      score += 20;
    }
    if (brokenImports > 0) {
      reasons.push(
        `${brokenImports} broken @import${brokenImports === 1 ? "" : "s"}`,
      );
      score += 20;
    }
    if (orphaned) {
      reasons.push("Not in MEMORY.md");
      score += 10;
    }

    const archiveEligible =
      (neverRead && ageMs >= archiveAgeMs) ||
      (sinceReadMs !== null && sinceReadMs >= staleReadMs);
    const deleteEligible =
      archiveEligible && (brokenRefs > 0 || brokenImports > 0 || orphaned);

    let recommendation: TriageRecommendation = "keep";
    if (deleteEligible) recommendation = "delete";
    else if (archiveEligible) recommendation = "archive";

    if (recommendation !== "keep") {
      candidates.push({ entry, recommendation, score: Math.min(score, 100), reasons });
      bytesRecoverable += entry.sizeBytes;
    }
  }

  candidates.sort((a, b) => {
    // Deletes first, archives second; within group, highest score first.
    if (a.recommendation !== b.recommendation) {
      return a.recommendation === "delete" ? -1 : 1;
    }
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.displayName.localeCompare(b.entry.displayName);
  });
  suppressed.sort((a, b) =>
    a.entry.displayName.localeCompare(b.entry.displayName),
  );

  return { candidates, suppressed, total, bytesRecoverable };
}
