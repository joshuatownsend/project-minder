import type { UsageTurn } from "./types";
import { extractWriteEdits } from "./fileActivity";

export interface FilePair {
  fileA: string;
  fileB: string;
  /** Number of sessions in which both files were edited. */
  coOccurrences: number;
  /** coOccurrences / max(sessionsA, sessionsB) — Jaccard-like [0, 1]. */
  strength: number;
}

export interface FileCouplingResult {
  pairs: FilePair[];
  totalSessions: number;
}

// Per-session file cap to avoid O(n²) blowup when a session touches hundreds
// of files (e.g. a broad refactor). Keeps the 200 most-recently-touched files.
const MAX_FILES_PER_SESSION = 200;

export function buildFileCoupling(
  turns: UsageTurn[],
  minCoOccurrences = 2,
  limit = 100
): FileCouplingResult {
  const edits = extractWriteEdits(turns);

  // Session → ordered set of file paths (insertion order = chronological)
  const sessionFiles = new Map<string, string[]>();
  for (const edit of edits) {
    let files = sessionFiles.get(edit.sessionId);
    if (!files) {
      files = [];
      sessionFiles.set(edit.sessionId, files);
    }
    if (!files.includes(edit.filePath)) {
      if (files.length < MAX_FILES_PER_SESSION) files.push(edit.filePath);
    }
  }

  // Per-file session counts (denominator for Jaccard strength)
  const fileSessions = new Map<string, number>();
  for (const files of sessionFiles.values()) {
    for (const file of files) {
      fileSessions.set(file, (fileSessions.get(file) ?? 0) + 1);
    }
  }

  // Co-occurrence counts — canonical pair key is alphabetically sorted,
  // null-byte separated so paths with spaces or special chars don't collide.
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
    const fileA = key.slice(0, sep);
    const fileB = key.slice(sep + 1);
    const sessionsA = fileSessions.get(fileA) ?? 0;
    const sessionsB = fileSessions.get(fileB) ?? 0;
    const strength = count / Math.max(sessionsA, sessionsB, 1);
    pairs.push({ fileA, fileB, coOccurrences: count, strength });
  }

  pairs.sort((a, b) => b.coOccurrences - a.coOccurrences || b.strength - a.strength);

  return { pairs: pairs.slice(0, limit), totalSessions: sessionFiles.size };
}
