import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { collectInventories } from "@/lib/drift/inventory";
import { detectDrift } from "@/lib/drift/compare";
import { DRIFT_KINDS, type DriftKind } from "@/lib/drift/types";

/**
 * Cross-harness drift, for the Settings panel.
 *
 * Drift findings originally rode along in `ScanResult.catalogLintFindings`,
 * which turned out to render nowhere: the Config Lint tab reads
 * `project.configLint`, and the catalog collection only feeds stats and
 * per-entry badges keyed on a catalog id — which a synthetic `drift:*` key
 * never matches. The feature produced counts and no readable findings.
 *
 * This route is the fix, and it sits where the subject actually lives.
 * Drift is a property of the machine's harness config homes, not of any one
 * project, so a per-project panel was the wrong home for it regardless;
 * Settings is where the adapters that enable it are configured.
 */

export const dynamic = "force-dynamic";

export interface DriftResponse {
  enabled: boolean;
  /** Harnesses compared: enabled AND present on this machine. */
  harnesses: { id: string; displayName: string; present: boolean; items: number }[];
  findings: {
    code: string;
    kind: DriftKind | "other";
    severity: string;
    title: string;
    fix: string;
  }[];
  /** Set when nothing was compared, explaining why rather than showing zero. */
  reason?: string;
}

function kindOf(code: string): DriftKind | "other" {
  const found = DRIFT_KINDS.find((k) => code.startsWith(`drift/${k}-`));
  return found ?? "other";
}

export async function GET(): Promise<NextResponse<DriftResponse>> {
  const config = await readConfig();
  const enabled = getFlag(config.featureFlags, "configDrift", true);
  if (!enabled) {
    return NextResponse.json({ enabled: false, harnesses: [], findings: [] });
  }

  const adapters = config.enabledAdapters ?? ["claude"];
  if (!adapters.includes("codex") && !adapters.includes("gemini")) {
    return NextResponse.json({
      enabled: true,
      harnesses: [],
      findings: [],
      reason:
        "Only Claude Code is enabled. Turn on the Codex or Gemini adapter above to compare configurations.",
    });
  }

  try {
    const inventories = await collectInventories(adapters);
    const findings = detectDrift(inventories);
    const present = inventories.filter((i) => i.present);

    return NextResponse.json({
      enabled: true,
      harnesses: inventories.map((i) => ({
        id: i.harness,
        displayName: i.displayName,
        present: i.present,
        items: i.items.length,
      })),
      findings: findings.map((f) => ({
        code: f.code,
        kind: kindOf(f.code),
        severity: f.severity,
        title: f.title,
        fix: f.fix,
      })),
      ...(present.length < 2
        ? {
            reason:
              "Fewer than two harness config homes exist on this machine, so there is nothing to compare.",
          }
        : {}),
    });
  } catch {
    return NextResponse.json({
      enabled: true,
      harnesses: [],
      findings: [],
      reason: "Could not read the harness config homes.",
    });
  }
}
