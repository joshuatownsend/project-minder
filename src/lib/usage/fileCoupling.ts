import type { UsageTurn } from "./types";
import { extractWriteEdits } from "./fileActivity";

export interface FilePair {
  readonly fileA: string;
  readonly fileB: string;
  /** Number of sessions in which both files were edited. */
  readonly coOccurrences: number;
  /** coOccurrences / max(sessionsA, sessionsB) — max-normalized overlap coefficient, range [0, 1]. */
  readonly strength: number;
}

export interface FileCouplingResult {
  readonly pairs: readonly FilePair[];
  /** Sessions with at least one write-class edit (denominator for co-occurrence context). */
  readonly totalSessions: number;
}

// Per-session file cap to avoid O(n²) blowup when a session touches hundreds
// of files (e.g. a broad refactor). Keeps the first 200 distinct files in
// chronological insertion order; files beyond the cap are silently dropped.
const MAX_FILES_PER_SESSION = 200;

export function buildFileCoupling(
  turns: UsageTurn[],
  minCoOccurrences = 2,
  limit = 100
): FileCouplingResult {
  const edits = extractWriteEdits(turns);

  // Session → ordered list of unique file paths (chronological insertion order).
  // Parallel Set per session for O(1) membership testing (vs O(n) Array.includes).
  const sessionFiles = new Map<string, string[]>();
  const sessionSeen = new Map<string, Set<string>>();
  for (const edit of edits) {
    let files = sessionFiles.get(edit.sessionId);
    let seen = sessionSeen.get(edit.sessionId);
    if (!files) {
      files = [];
      seen = new Set();
      sessionFiles.set(edit.sessionId, files);
      sessionSeen.set(edit.sessionId, seen);
    }
    if (!seen!.has(edit.filePath) && files.length < MAX_FILES_PER_SESSION) {
      seen!.add(edit.filePath);
      files.push(edit.filePath);
    }
  }

  // Per-file session counts (denominator for strength calculation)
  const fileSessions = new Map<string, number>();
  for (const files of sessionFiles.values()) {
    for (const file of files) {
      fileSessions.set(file, (fileSessions.get(file) ?? 0) + 1);
    }
  }

  // Co-occurrence counts — canonical pair key is alphabetically sorted,
  // NUL-byte separated (the one byte filesystems forbid in path components,
  // so it cannot appear in either half of the key).
  const pairCounts = new Map<string, number>();
  for (const files of sessionFiles.values()) {
    const sorted = [...files].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = sorted[i] + "\0" + sorted[j];
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const pairs: FilePair[] = [];
  for (const [key, count] of pairCounts) {
    if (count < minCoOccurrences) continue;
    const sep = key.indexOf("\0");
    if (sep === -1) continue; // key invariant violated — skip rather than corrupt output
    const fileA = key.slice(0, sep);
    const fileB = key.slice(sep + 1);
    const sessionsA = fileSessions.get(fileA) ?? 0;
    const sessionsB = fileSessions.get(fileB) ?? 0;
    // Math.min(1, ...) guards against inflation from MAX_FILES_PER_SESSION
    // asymmetric truncation (a file evicted in some sessions gets a lower
    // fileSessions count than its true session membership).
    const strength = Math.min(1, count / Math.max(sessionsA, sessionsB, 1));
    pairs.push({ fileA, fileB, coOccurrences: count, strength });
  }

  pairs.sort((a, b) => b.coOccurrences - a.coOccurrences || b.strength - a.strength);

  return { pairs: pairs.slice(0, limit), totalSessions: sessionFiles.size };
}
