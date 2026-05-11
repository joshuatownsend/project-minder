// Line-level diff for the seed conflict UI. Not a full Myers diff — we don't
// need to render character-level moves. The seed page just has to show the
// user "here's what's already there, here's what we'd add, here's what would
// change" so they can pick a per-file action: keep existing, overwrite with
// proposed, or write a manually-merged body.

export type DiffOp = "equal" | "added" | "removed";

export interface DiffSegment {
  op: DiffOp;
  /** Source line numbers (1-indexed) on the existing side, or null when added. */
  existingLine: number | null;
  /** Source line numbers (1-indexed) on the proposed side, or null when removed. */
  proposedLine: number | null;
  text: string;
}

export interface DiffSummary {
  segments: DiffSegment[];
  added: number;
  removed: number;
  equal: number;
}

/**
 * Compute a line-level LCS diff between `existing` and `proposed`. Output is
 * a flat segment list suitable for rendering the existing | proposed | merged
 * columns in the UI. Both sides are split on `\r?\n` so CRLF doesn't produce
 * a parallel-universe diff.
 */
export function diffMemoryBodies(existing: string, proposed: string): DiffSummary {
  const left = existing.split(/\r?\n/);
  const right = proposed.split(/\r?\n/);
  const segments = lcsDiff(left, right);
  let added = 0;
  let removed = 0;
  let equal = 0;
  for (const s of segments) {
    if (s.op === "added") added++;
    else if (s.op === "removed") removed++;
    else equal++;
  }
  return { segments, added, removed, equal };
}

/**
 * Plain LCS-based line diff. O(n*m) time + memory; fine for memory files
 * which are typically <200 lines on either side. If we ever hit a 10k-line
 * memory we'd swap for Myers, but the budget chips would flag the file
 * before that anyway.
 */
function lcsDiff(left: string[], right: string[]): DiffSegment[] {
  const n = left.length;
  const m = right.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (left[i - 1] === right[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const segments: DiffSegment[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (left[i - 1] === right[j - 1]) {
      segments.push({ op: "equal", existingLine: i, proposedLine: j, text: left[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      segments.push({ op: "removed", existingLine: i, proposedLine: null, text: left[i - 1] });
      i--;
    } else {
      segments.push({ op: "added", existingLine: null, proposedLine: j, text: right[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    segments.push({ op: "removed", existingLine: i, proposedLine: null, text: left[i - 1] });
    i--;
  }
  while (j > 0) {
    segments.push({ op: "added", existingLine: null, proposedLine: j, text: right[j - 1] });
    j--;
  }
  return segments.reverse();
}
