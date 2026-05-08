export interface DiffLine {
  kind: "removed" | "added" | "context";
  text: string;
}

/**
 * Produce a line-level unified diff between two strings.
 * Returns at most `maxLines` lines total; appends a truncation note if cut.
 * No external dependency — only used for Edit tool old→new display.
 */
export function lineDiff(
  oldStr: string,
  newStr: string,
  maxLines = 200
): DiffLine[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const result: DiffLine[] = [];

  // Simple LCS-based diff: use the longest-common-subsequence Myers diff.
  // For small inputs (tool args are capped at 32 KB), the naive O(m*n)
  // approach is fast enough and avoids a dependency on a diff library.
  const lcs = computeLCS(oldLines, newLines);
  let oi = 0;
  let ni = 0;
  let li = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (result.length >= maxLines) {
      result.push({ kind: "context", text: `… (${oldLines.length - oi + newLines.length - ni} more lines)` });
      break;
    }
    if (li < lcs.length && oi < oldLines.length && ni < newLines.length &&
        oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
      result.push({ kind: "context", text: oldLines[oi] });
      oi++; ni++; li++;
    } else if (ni < newLines.length &&
               (li >= lcs.length || newLines[ni] !== lcs[li])) {
      result.push({ kind: "added", text: newLines[ni++] });
    } else {
      result.push({ kind: "removed", text: oldLines[oi++] });
    }
  }

  return result;
}

function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  // Limit to avoid O(m*n) blowup on huge strings.
  if (m * n > 40_000) return [];
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const lcs: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { lcs.unshift(a[i - 1]); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return lcs;
}
