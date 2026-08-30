import "server-only";
import { createHash } from "crypto";
import type { Database } from "better-sqlite3";
import type { MinderConfig } from "@/lib/types";
import { getClaudeHomes, homeDedupeKey } from "@/lib/claudeHome";

/**
 * Whether the last full DB reconcile read the corpus through — and whether that
 * answer is still about the corpus we have now (#529).
 *
 * ## Why this is not "read the aborted bit"
 *
 * `reconcileAllSessions` already counts enumeration failures and persists them
 * as `aborted` on its `indexer_runs` row. Reading that back was tried in PR #527
 * and reverted after four review rounds. Two of the five findings are the reason
 * this module exists at all:
 *
 * 1. **The run row does not survive steady state.** `recordOptionForSweep`
 *    deliberately returns `{}` once any clean full pass exists — those rows
 *    clear a readiness latch, they are not a log — so the 30-second sweeps write
 *    nothing. Reading the latest RECORDED run answers with the startup pass
 *    forever, and a permissions failure appearing later stays invisible. So the
 *    verdict here is written by EVERY full pass, whatever `recordRun` says.
 *
 * 2. **A persisted flag needs invalidation that a delete cannot give it.** If a
 *    config change deletes the flag while a stale `aborted` run row survives, a
 *    read that falls back to that row re-asserts the verdict the reset just
 *    cleared. So the verdict carries a CORPUS VERSION and nothing ever falls
 *    back to `indexer_runs`: a version that no longer matches is not a stale
 *    answer to be aged out, it is an answer to a different question.
 *
 * ## What defines the corpus
 *
 * The same inputs `/api/config` already treats as changing which sessions a
 * sweep returns: the effective Claude home set and the enabled adapters. Homes
 * go through `getClaudeHomes` and `homeDedupeKey` rather than the raw config
 * array, so a reorder, an equivalent spelling, or an entry redundant with the
 * implicit primary all count as no change — the same comparison
 * `corpusShapeChanged` makes, for the same reason.
 *
 * `pathMappings` is deliberately absent. It changes what the rollups MEAN, not
 * which directories are enumerated, and invalidating on it would discard a live
 * diagnostic about a directory that is still unreadable.
 */
export interface ReconcileVerdict {
  /** The pass could not enumerate part of the corpus it was asked to read. */
  incomplete: boolean;
  /** How many enumerations failed, for the diagnostic text. */
  enumerationFailures: number;
}

const META_KEY = "reconcile_verdict";

/** A stable fingerprint of the set a full reconcile is expected to walk. */
export function computeCorpusVersion(config: MinderConfig): string {
  const homes = [...new Set(getClaudeHomes(config).map(homeDedupeKey))].sort();
  const adapters = [...(config.enabledAdapters ?? [])].sort();
  return createHash("sha256")
    .update(JSON.stringify({ homes, adapters }))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Record what this pass saw. Called by every full pass, including the 30-second
 * sweeps that record no run row — see the note above on why that matters.
 */
export function writeReconcileVerdict(
  db: Database,
  corpusVersion: string,
  verdict: ReconcileVerdict
): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
    .run(META_KEY, JSON.stringify({ corpusVersion, ...verdict }), JSON.stringify({ corpusVersion, ...verdict }));
}

/**
 * The verdict, or `null` when there isn't one for THIS corpus.
 *
 * `null` is "no claim", not "complete". A fresh index, a config change that
 * moved the swept set, and an unreadable row all land here, and the caller must
 * treat that as nothing-to-report rather than as a clean bill of health — the
 * quiet direction, matching the rule that a machine before its first session is
 * not degraded.
 */
export function readReconcileVerdict(
  db: Database,
  corpusVersion: string
): ReconcileVerdict | null {
  let row: { value: string } | undefined;
  try {
    row = db.prepare("SELECT value FROM meta WHERE key = ?").get(META_KEY) as
      | { value: string }
      | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<ReconcileVerdict> & {
      corpusVersion?: string;
    };
    // A verdict about a different corpus answers a question nobody asked.
    if (parsed.corpusVersion !== corpusVersion) return null;
    if (typeof parsed.incomplete !== "boolean") return null;
    return {
      incomplete: parsed.incomplete,
      enumerationFailures:
        typeof parsed.enumerationFailures === "number" ? parsed.enumerationFailures : 0,
    };
  } catch {
    return null;
  }
}
