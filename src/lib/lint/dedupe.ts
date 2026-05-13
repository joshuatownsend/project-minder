import type { LintFinding, LintEngine } from "../types";

/**
 * Merge findings from multiple engine passes, keeping the highest-priority
 * source per (target, file, rule-family) tuple. "Rule-family" is the code
 * with the `<target>/` prefix stripped so both engines' namespaced copies of
 * the same rule collapse into one.
 *
 * Priority: library > vendored > adapter.
 *
 * Wave A: only the adapter pass runs, so no conflicts are possible. The real
 * dedup logic below is a no-op because all findings come from a single engine.
 * Wave B wires library + vendored passes, at which point the priority map
 * starts resolving actual conflicts.
 */
export function dedupeFindings(buckets: LintFinding[][]): LintFinding[] {
  const ENGINE_PRIORITY: Record<LintEngine, number> = {
    library: 2,
    vendored: 1,
    adapter: 0,
  };

  const best = new Map<string, LintFinding>();

  for (const findings of buckets) {
    for (const f of findings) {
      const ruleFamily = f.code.replace(/^[^/]+\//, "");
      // When no file path, use the finding title to distinguish multiple
      // findings from the same rule targeting different items (e.g. two
      // unpinned plugins each produce a unique title).
      const key = `${f.target}::${f.file ?? f.title}::${ruleFamily}`;
      const existing = best.get(key);
      if (!existing || ENGINE_PRIORITY[f.engine] > ENGINE_PRIORITY[existing.engine]) {
        best.set(key, f);
      }
    }
  }

  return Array.from(best.values());
}
