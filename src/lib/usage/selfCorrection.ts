import type { UsageTurn } from "./types";

// Scan assistant text for phrases that indicate the model is correcting
// itself, then aggregate per primary model. Spec:
//
//   - Phrase set: "my mistake", "I was wrong", "I apologize", "actually,",
//     "let me reconsider", "I made an error", "I need to correct".
//   - Per-session dedup: a session counts as "corrected" if any assistant
//     turn matched at least one phrase. We do NOT count phrase recurrences
//     (avoids inflation on retry loops where the same correction is
//     re-emitted across consecutive turns).
//   - Aggregate per *primary model* — the model with the most assistant
//     turns in the session. Rate = correctedSessions / sessionsForModel.
//
// Notes on phrase reliability:
//
//   "actually," is the noisiest of the seven — it shows up in non-correction
//   contexts (e.g. "actually, that's correct"). To suppress the most
//   obvious false positives, we require it to appear at sentence start
//   (preceded by start-of-text or sentence-ending punctuation + space).
//   The other six phrases are correction-flavored on their own and don't
//   need extra anchoring. Per-session dedup further mutes phrase noise:
//   a session with one stray "actually," still only counts as one
//   corrected session, not many.

const STRICT_ACTUALLY_RE = /(?:^|[.!?\n]\s+)actually,/i;

/** All other correction phrases — matched as case-insensitive substrings. */
const SIMPLE_PHRASE_REGEXPS: RegExp[] = [
  /my mistake/i,
  /\bi was wrong\b/i,
  /i apologi[sz]e/i,        // "apologize" (US) or "apologise" (UK)
  /let me reconsider/i,
  /i made an (?:a |another |yet another )?error/i,
  /i need to correct/i,
];

/** Returns true when the given assistant text carries a correction signal. */
export function textHasSelfCorrection(text: string): boolean {
  if (!text) return false;
  if (STRICT_ACTUALLY_RE.test(text)) return true;
  for (const re of SIMPLE_PHRASE_REGEXPS) {
    if (re.test(text)) return true;
  }
  return false;
}

interface SessionAccum {
  /** Per-model assistant turn counts. */
  modelTurns: Map<string, number>;
  /** Whether at least one assistant turn in this session matched a
   *  correction phrase. */
  corrected: boolean;
}

export interface ModelSelfCorrection {
  model: string;
  corrected: number;
  total: number;
  /** corrected / total, in [0, 1]. */
  rate: number;
}

export interface SelfCorrectionReport {
  /** Sorted by `total` descending so consumers see the most-attributed
   *  models first. Returned as a frozen array, NOT a Map — `JSON.stringify`
   *  on a Map produces `{}`, which would silently break any future API
   *  shape that surfaces this report directly. */
  readonly byModel: readonly ModelSelfCorrection[];
}

/**
 * Compute per-primary-model self-correction rates over the given turns.
 * The caller is responsible for whatever filtering applies (period,
 * project) before invoking — this function operates on whatever you
 * hand it.
 */
export function detectSelfCorrectionPerModel(turns: UsageTurn[]): SelfCorrectionReport {
  // Group assistant turns by session, then detect the correction
  // phrase against `assistantText` (sliced to ~500 chars by the parser
  // / DB ingest paths). 500 chars is more than enough for the phrase
  // regexps, and the cap keeps the in-memory turn shape compact.
  const sessions = new Map<string, SessionAccum>();
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    let entry = sessions.get(t.sessionId);
    if (!entry) {
      entry = { modelTurns: new Map(), corrected: false };
      sessions.set(t.sessionId, entry);
    }
    entry.modelTurns.set(t.model, (entry.modelTurns.get(t.model) ?? 0) + 1);

    if (!entry.corrected && t.assistantText && textHasSelfCorrection(t.assistantText)) {
      entry.corrected = true;
    }
  }

  // Second pass: roll up to per-primary-model counts.
  const modelStats = new Map<string, { corrected: number; total: number }>();
  for (const session of sessions.values()) {
    const primary = pickPrimaryModel(session.modelTurns);
    if (!primary) continue;
    let stats = modelStats.get(primary);
    if (!stats) {
      stats = { corrected: 0, total: 0 };
      modelStats.set(primary, stats);
    }
    stats.total++;
    if (session.corrected) stats.corrected++;
  }

  const byModel: ModelSelfCorrection[] = [];
  for (const [model, stats] of modelStats.entries()) {
    byModel.push({
      model,
      corrected: stats.corrected,
      total: stats.total,
      rate: stats.total > 0 ? stats.corrected / stats.total : 0,
    });
  }
  byModel.sort((a, b) => b.total - a.total);
  return { byModel: Object.freeze(byModel) };
}

function pickPrimaryModel(modelTurns: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = -1;
  for (const [model, count] of modelTurns.entries()) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}
