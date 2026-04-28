import {
  ApplyRequest,
  ApplyResult,
  ApplyTarget,
  ApplyTemplateRequest,
  ApplyTemplateResult,
  ConflictPolicy,
  TemplateUnitRef,
} from "../types";
import { readConfig } from "../config";
import { getCachedScan, setCachedScan, invalidateCache as invalidateScanCache } from "../cache";
import { scanAllProjects } from "../scanner";
import { invalidateCatalogCache } from "../indexer/catalog";
import { invalidateClaudeConfigRouteCache } from "@/app/api/claude-config/route";
import { applyUnit } from "./apply";
import { readManifest } from "./manifest";
import { resolveTemplateSourcePath } from "./resolveAssets";
import { bootstrapNewProject } from "./bootstrap";
import { flattenInventory } from "./promote";

/**
 * Top-level orchestrator for "apply this whole template to a target."
 * Resolves source location (live source project OR snapshot bundle), bootstraps
 * the target if requested, then iterates the manifest's unit inventory and
 * dispatches each through `applyUnit` with internal `kind:"path"` source +
 * target so live and snapshot work uniformly.
 */
export async function applyTemplate(req: ApplyTemplateRequest): Promise<ApplyTemplateResult> {
  const config = await readConfig();
  let scan = await getOrLoadScan();

  // 1. Read manifest.
  const manifestRead = await readManifest(config, req.templateSlug);
  if (!manifestRead) {
    return errorAggregate("UNKNOWN_TEMPLATE", `No template with slug "${req.templateSlug}".`);
  }
  if ("errors" in manifestRead) {
    const summary = manifestRead.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
    return errorAggregate("INVALID_MANIFEST", summary);
  }
  const manifest = manifestRead.manifest;

  // 2. Resolve source path (live source project OR snapshot bundle).
  const sourceResolved = await resolveTemplateSourcePath(manifest, config, scan);
  if ("error" in sourceResolved) {
    return errorAggregate(sourceResolved.error.code, sourceResolved.error.message);
  }
  const sourcePath = sourceResolved.path;

  // 3. Resolve / bootstrap target. Bootstrap turns a "new" target into a
  //    "path" target so the inner applyUnit calls don't have to think about
  //    bootstrap concerns.
  let resolvedTarget: ApplyTarget;
  let bootstrap: ApplyTemplateResult["bootstrap"] | undefined;

  if (req.target.kind === "new") {
    const r = await bootstrapNewProject(config, {
      name: req.target.name,
      relPath: req.target.relPath,
      gitInit: req.target.gitInit,
    });
    if (!r.ok) return errorAggregate(r.error.code, r.error.message);
    resolvedTarget = { kind: "path", path: r.createdPath };
    bootstrap = { createdPath: r.createdPath, gitInitialized: r.gitInitialized };
  } else {
    resolvedTarget = req.target;
  }

  // 4. Iterate units. Errors on individual units don't abort — collect all and
  //    let the UI show the user which succeeded.
  const units = flattenInventory(manifest.units);
  const results: Array<{ unit: TemplateUnitRef; result: ApplyResult }> = [];

  for (const unit of units) {
    const conflict = pickConflict(unit, req);
    const apply: ApplyRequest = {
      unit: { kind: unit.kind, key: unit.key },
      source: { kind: "path", path: sourcePath },
      target: resolvedTarget,
      conflict,
      dryRun: req.dryRun,
    };
    const result = await applyUnit(apply);
    results.push({ unit, result });
  }

  // 5. On a real apply (not dryRun), invalidate caches once at the end so
  //    the post-apply scan sees a fresh state.
  const anyChanged = results.some(
    (r) => r.result.ok && !req.dryRun && r.result.status !== "skipped" && r.result.status !== "would-apply"
  );
  if (anyChanged) {
    invalidateScanCache();
    invalidateCatalogCache();
    invalidateClaudeConfigRouteCache();
    // Refresh the scan so any UI reading it picks up the new project / units immediately.
    scan = await scanAllProjects();
    setCachedScan(scan);
  }

  return {
    ok: true,
    results,
    summary: tallyResults(results, req.dryRun ?? false),
    bootstrap,
  };
}

function pickConflict(
  unit: TemplateUnitRef,
  req: ApplyTemplateRequest
): ConflictPolicy {
  const id = `${unit.kind}:${unit.key}`;
  return req.perUnitConflict?.[id] ?? req.conflictDefault;
}

function tallyResults(
  results: Array<{ result: ApplyResult }>,
  dryRun: boolean
): ApplyTemplateResult["summary"] {
  const summary = { applied: 0, merged: 0, skipped: 0, errors: 0, wouldApply: 0 };
  for (const { result } of results) {
    if (!result.ok) {
      summary.errors += 1;
      continue;
    }
    switch (result.status) {
      case "applied":
        summary.applied += 1;
        break;
      case "merged":
        summary.merged += 1;
        break;
      case "skipped":
        summary.skipped += 1;
        break;
      case "would-apply":
        summary.wouldApply += 1;
        break;
      case "error":
        summary.errors += 1;
        break;
    }
  }
  // dryRun never produces "applied"/"merged" — they're all "would-apply".
  // The shape stays uniform regardless, which keeps the UI summary code simple.
  void dryRun;
  return summary;
}

async function getOrLoadScan() {
  const cached = getCachedScan();
  if (cached) return cached;
  const fresh = await scanAllProjects();
  setCachedScan(fresh);
  return fresh;
}

function errorAggregate(code: string, message: string): ApplyTemplateResult {
  return {
    ok: false,
    results: [],
    summary: { applied: 0, merged: 0, skipped: 0, errors: 0, wouldApply: 0 },
    error: { code, message },
  };
}

/** Convenience for the API route — also exported via the entry barrel. */
export { readManifest };
