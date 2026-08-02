import type { LintFinding } from "../types";
import {
  DRIFT_KINDS,
  DRIFT_KIND_LABEL,
  type DriftItem,
  type DriftKind,
  type HarnessInventory,
} from "./types";

/**
 * Cross-harness drift detection (pure).
 *
 * Two shapes of finding, deliberately different in granularity:
 *
 * **Divergence is summarized.** On a real machine Claude carries ~57 user
 * skills and Codex carries 8. Emitting one finding per missing item produces
 * ~49 rows that no one reads, and buries the two that matter. So a
 * one-directional gap becomes a single finding per (kind, source → target)
 * naming a count and a sample.
 *
 * **Conflicts are per-item.** When both harnesses have an item under the same
 * name but define it differently — an MCP server pointed at a different
 * command — one of them is stale. Those are few and individually actionable,
 * so each gets its own finding.
 *
 * Everything is P2. Drift is advisory: two harnesses configured differently is
 * frequently deliberate, and `LintReport.hasBlocking` is documented as "the
 * config fails strict lint". Letting a parity observation fail someone's CI
 * gate would be a surprising consequence of enabling a second adapter.
 */

/** Names listed inline before the finding switches to a count. */
const SAMPLE_LIMIT = 5;

export function detectDrift(inventories: HarnessInventory[]): LintFinding[] {
  // Only harnesses that are both enabled (the caller's filter) and actually
  // installed can participate. With fewer than two there is nothing to
  // compare, and the default `enabledAdapters` of `["claude"]` lands here —
  // so this feature is silent until a user opts a second harness in.
  const present = inventories.filter((inv) => inv.present);
  if (present.length < 2) return [];

  const findings: LintFinding[] = [];
  for (const kind of DRIFT_KINDS) {
    const participants = present.filter((inv) => inv.supports.includes(kind));
    if (participants.length < 2) continue;
    findings.push(...compareKind(kind, participants));
  }
  return findings;
}

function compareKind(kind: DriftKind, harnesses: HarnessInventory[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const byHarness = new Map<string, Map<string, DriftItem>>();
  for (const inv of harnesses) {
    const map = new Map<string, DriftItem>();
    for (const item of inv.items) {
      if (item.kind !== kind) continue;
      // First spelling wins; a harness listing the same key twice is its own
      // problem and not one this comparison can usefully report.
      if (!map.has(item.key)) map.set(item.key, item);
    }
    byHarness.set(inv.harness, map);
  }

  for (const source of harnesses) {
    const sourceItems = byHarness.get(source.harness)!;
    if (sourceItems.size === 0) continue;

    for (const target of harnesses) {
      if (target.harness === source.harness) continue;
      const targetItems = byHarness.get(target.harness)!;

      const missing: DriftItem[] = [];
      for (const [key, item] of sourceItems) {
        if (!targetItems.has(key)) missing.push(item);
      }
      if (missing.length > 0) {
        findings.push(missingFinding(kind, source, target, missing));
      }
    }
  }

  findings.push(...conflictFindings(kind, harnesses, byHarness));
  return findings;
}

function missingFinding(
  kind: DriftKind,
  source: HarnessInventory,
  target: HarnessInventory,
  missing: DriftItem[],
): LintFinding {
  const label = DRIFT_KIND_LABEL[kind];
  const noun = missing.length === 1 ? label.one : label.many;
  const names = missing
    .map((m) => m.name)
    .sort((a, b) => a.localeCompare(b));
  const sample = names.slice(0, SAMPLE_LIMIT).join(", ");
  // The overflow count is stated rather than the list silently cut — a
  // truncated sample that looks complete is how a "5 skills" finding gets
  // read as the whole story when it is 5 of 49.
  const rest = names.length > SAMPLE_LIMIT ? `, and ${names.length - SAMPLE_LIMIT} more` : "";

  return {
    target: "drift",
    code: `drift/${kind}-missing`,
    severity: "P2",
    title: `${missing.length} ${noun} configured for ${source.displayName} but not ${target.displayName}`,
    fix:
      `${sample}${rest}. Minder never writes harness config — add them under ` +
      `${target.home} yourself if the parity is wanted, or ignore this if the ` +
      `harnesses are meant to differ.`,
    penalty: 0,
    engine: "vendored",
    file: `drift:${kind}:${source.harness}->${target.harness}`,
  };
}

/**
 * Same key in two harnesses, different definition. Only emitted for kinds
 * that carry a `signature`; skills and instructions deliberately don't,
 * because fingerprinting them means reading every file on every scan.
 */
function conflictFindings(
  kind: DriftKind,
  harnesses: HarnessInventory[],
  byHarness: Map<string, Map<string, DriftItem>>,
): LintFinding[] {
  const findings: LintFinding[] = [];
  const label = DRIFT_KIND_LABEL[kind];

  for (let i = 0; i < harnesses.length; i++) {
    for (let j = i + 1; j < harnesses.length; j++) {
      const a = harnesses[i];
      const b = harnesses[j];
      const aItems = byHarness.get(a.harness)!;
      const bItems = byHarness.get(b.harness)!;

      for (const [key, aItem] of aItems) {
        const bItem = bItems.get(key);
        if (!bItem) continue;
        if (!aItem.signature || !bItem.signature) continue;
        if (aItem.signature === bItem.signature) continue;

        findings.push({
          target: "drift",
          code: `drift/${kind}-conflict`,
          severity: "P2",
          title: `${label.one} "${aItem.name}" is defined differently in ${a.displayName} and ${b.displayName}`,
          fix:
            `${a.displayName}: ${truncate(aItem.signature)} · ` +
            `${b.displayName}: ${truncate(bItem.signature)}. ` +
            `One is probably a stale copy — check which reflects the current setup.`,
          penalty: 0,
          engine: "vendored",
          file: `drift:${kind}:${key}`,
        });
      }
    }
  }
  return findings;
}

function truncate(value: string, max = 90): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
