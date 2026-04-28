import path from "path";
import {
  ApplyRequest,
  ApplyResult,
  ApplySource,
  ApplyTarget,
  HookEntry,
  McpServer,
  MinderConfig,
  ScanResult,
} from "../types";
import { readConfig } from "../config";
import { getCachedScan, setCachedScan, invalidateCache as invalidateScanCache } from "../cache";
import { scanAllProjects } from "../scanner";
import { scanClaudeHooks } from "../scanner/claudeHooks";
import { scanMcpServers } from "../scanner/mcpServers";
import { invalidateCatalogCache } from "../indexer/catalog";
import { invalidateClaudeConfigRouteCache } from "@/app/api/claude-config/route";
import { invalidateCommandsRouteCache } from "@/app/api/commands/route";
import { walkProjectCommands, walkUserCommands } from "../indexer/walkCommands";
import { walkProjectAgents, walkUserAgents } from "../indexer/walkAgents";
import { walkProjectSkills, walkUserSkills } from "../indexer/walkSkills";
import { loadProvenanceContext } from "../indexer/provenance";
import type { AgentEntry, SkillEntry } from "../indexer/types";
import { applySingleFile, applyDirectory } from "./applyFile";
import { applyHook } from "./applyHook";
import { applyMcp } from "./applyMcp";
import { applyPlugin } from "./applyPlugin";
import { applyWorkflow } from "./applyWorkflow";
import { applySettings } from "./applySettings";
import { ensureInsideDevRoots, PathSafetyError } from "./pathSafety";
import { explodeHookCommands, findHookByKey, findMcpByKey } from "./unitKey";
import { scanProjectPluginEnables } from "../scanner/projectPlugins";

/** Resolved source location: either a virtual-project root path (with a slug
 *  used only by walkers for entry-id construction) or a user-scope flag. */
type ResolvedSource =
  | { kind: "project"; path: string; slug: string }
  | { kind: "user" };

function resolveSource(source: ApplySource, scan: ScanResult): ResolvedSource | { error: { code: string; message: string } } {
  switch (source.kind) {
    case "user":
      return { kind: "user" };
    case "project": {
      const proj = scan.projects.find((p) => p.slug === source.slug);
      if (!proj) {
        return { error: { code: "UNKNOWN_SOURCE_PROJECT", message: `No project with slug "${source.slug}".` } };
      }
      return { kind: "project", path: proj.path, slug: proj.slug };
    }
    case "path":
      // Internal-only — used by the template apply layer with snapshot bundles
      // and live-source projects. Slug is a synthetic placeholder used only by
      // walkers when they construct entry ids.
      return { kind: "project", path: source.path, slug: "template" };
  }
}

function resolveTarget(target: ApplyTarget, scan: ScanResult): { path: string } | { error: { code: string; message: string } } {
  switch (target.kind) {
    case "existing": {
      const proj = scan.projects.find((p) => p.slug === target.slug);
      if (!proj) {
        return { error: { code: "UNKNOWN_TARGET_PROJECT", message: `No project with slug "${target.slug}".` } };
      }
      return { path: proj.path };
    }
    case "new":
      // applyUnit doesn't bootstrap directories — the template apply layer
      // handles "new" by creating the directory first, then dispatching with
      // target.kind === "path". Reject here so a misuse is loud.
      return {
        error: {
          code: "UNSUPPORTED_TARGET",
          message: `applyUnit doesn't accept target.kind="new"; route via applyTemplate instead.`,
        },
      };
    case "path":
      return { path: target.path };
  }
}

/**
 * Top-level orchestrator. Resolves source + target paths, dispatches to the
 * right primitive, and (on a successful non-dryRun) invalidates the caches
 * that the dashboard / browsers read from.
 */
export async function applyUnit(request: ApplyRequest): Promise<ApplyResult> {
  const config = await readConfig();
  const scan = await getOrLoadScan();

  const targetResolved = resolveTarget(request.target, scan);
  if ("error" in targetResolved) {
    return errorResult(targetResolved.error.code, targetResolved.error.message);
  }

  let safeTargetPath: string;
  try {
    safeTargetPath = ensureInsideDevRoots(targetResolved.path, config);
  } catch (e) {
    if (e instanceof PathSafetyError) {
      return errorResult(e.code, e.message);
    }
    throw e;
  }

  const sourceResolved = resolveSource(request.source, scan);
  if ("error" in sourceResolved) {
    return errorResult(sourceResolved.error.code, sourceResolved.error.message);
  }

  // Dispatch by unit kind.
  let result: ApplyResult;
  try {
    switch (request.unit.kind) {
      case "agent":
        result = await dispatchAgent(request, sourceResolved, safeTargetPath);
        break;
      case "skill":
        result = await dispatchSkill(request, sourceResolved, safeTargetPath);
        break;
      case "command":
        result = await dispatchCommand(request, sourceResolved, safeTargetPath);
        break;
      case "hook":
        result = await dispatchHook(request, sourceResolved, safeTargetPath);
        break;
      case "mcp":
        result = await dispatchMcp(request, sourceResolved, safeTargetPath);
        break;
      case "plugin":
        result = await dispatchPlugin(request, sourceResolved, safeTargetPath);
        break;
      case "workflow":
        result = await dispatchWorkflow(request, sourceResolved, safeTargetPath);
        break;
      case "settingsKey":
        result = await dispatchSettings(request, sourceResolved, safeTargetPath);
        break;
      default:
        result = errorResult("UNKNOWN_UNIT_KIND", `Unsupported unit kind "${request.unit.kind}".`);
    }
  } catch (e) {
    result = errorResult("APPLY_THREW", (e as Error).message);
  }

  // Invalidate caches on a successful, non-dryRun apply. We invalidate every
  // catalog/route cache that could have served stale data for the unit kind
  // we just wrote, regardless of which kind it was — figuring out per-kind
  // which caches are affected is more error-prone than just clearing all four.
  if (result.ok && !request.dryRun && result.status !== "skipped") {
    invalidateScanCache();
    invalidateCatalogCache();
    invalidateClaudeConfigRouteCache();
    invalidateCommandsRouteCache();
  }

  return result;
}

async function dispatchAgent(
  request: ApplyRequest,
  source: ResolvedSource,
  targetProjectPath: string
): Promise<ApplyResult> {
  const entry = await findAgent(request.unit.key, source);
  if (!entry) return errorResult("UNIT_NOT_FOUND", `Agent "${request.unit.key}" not found in source.`);

  const sourceFile = entry.realPath ?? entry.filePath;
  const targetFile = path.join(targetProjectPath, ".claude", "agents", `${entry.slug}.md`);
  return applySingleFile({
    sourcePath: sourceFile,
    targetPath: targetFile,
    conflict: request.conflict,
    dryRun: request.dryRun,
  });
}

async function dispatchSkill(
  request: ApplyRequest,
  source: ResolvedSource,
  targetProjectPath: string
): Promise<ApplyResult> {
  const entry = await findSkill(request.unit.key, source);
  if (!entry) return errorResult("UNIT_NOT_FOUND", `Skill "${request.unit.key}" not found in source.`);

  if (entry.layout === "bundled") {
    const sourceDir = path.dirname(entry.realPath ?? entry.filePath);
    const targetDir = path.join(targetProjectPath, ".claude", "skills", entry.slug);
    return applyDirectory({
      sourceDir,
      targetDir,
      conflict: request.conflict,
      dryRun: request.dryRun,
    });
  }
  const sourceFile = entry.realPath ?? entry.filePath;
  const targetFile = path.join(targetProjectPath, ".claude", "skills", `${entry.slug}.md`);
  return applySingleFile({
    sourcePath: sourceFile,
    targetPath: targetFile,
    conflict: request.conflict,
    dryRun: request.dryRun,
  });
}

async function dispatchCommand(
  request: ApplyRequest,
  source: ResolvedSource,
  targetProjectPath: string
): Promise<ApplyResult> {
  const entries =
    source.kind === "user"
      ? await walkUserCommands()
      : await walkProjectCommands(source.path, source.slug);
  const entry = entries.find((e) => e.slug === request.unit.key);
  if (!entry) return errorResult("UNIT_NOT_FOUND", `Command "${request.unit.key}" not found in source.`);

  const sourceFile = entry.realPath ?? entry.filePath;
  const targetFile = path.join(targetProjectPath, ".claude", "commands", `${entry.slug}.md`);
  return applySingleFile({
    sourcePath: sourceFile,
    targetPath: targetFile,
    conflict: request.conflict,
    dryRun: request.dryRun,
  });
}

async function dispatchHook(
  request: ApplyRequest,
  source: ResolvedSource,
  targetProjectPath: string
): Promise<ApplyResult> {
  if (source.kind !== "project") {
    return errorResult("UNSUPPORTED_SOURCE", "Hook source must be a project (user-scope hooks not supported in V1/V2).");
  }
  const hooksInfo = await scanClaudeHooks(source.path);
  const allEntries: HookEntry[] = hooksInfo?.entries ?? [];
  const exploded = allEntries.flatMap(explodeHookCommands);
  const entry = findHookByKey(exploded, request.unit.key);
  if (!entry) return errorResult("UNIT_NOT_FOUND", `Hook "${request.unit.key}" not found in source.`);

  return applyHook({
    entry,
    sourceProjectPath: source.path,
    targetProjectPath,
    conflict: request.conflict,
    dryRun: request.dryRun,
  });
}

async function dispatchMcp(
  request: ApplyRequest,
  source: ResolvedSource,
  targetProjectPath: string
): Promise<ApplyResult> {
  if (source.kind !== "project") {
    return errorResult("UNSUPPORTED_SOURCE", "MCP source must be a project (user-scope MCP not supported in V1/V2).");
  }
  const mcpInfo = await scanMcpServers(source.path);
  const all: McpServer[] = mcpInfo?.servers ?? [];
  const server = findMcpByKey(all, request.unit.key);
  if (!server) return errorResult("UNIT_NOT_FOUND", `MCP server "${request.unit.key}" not found in source.`);

  return applyMcp({
    server,
    targetProjectPath,
    conflict: request.conflict,
    sourceSlug: source.slug,
    dryRun: request.dryRun,
  });
}

async function dispatchWorkflow(
  request: ApplyRequest,
  source: ResolvedSource,
  targetProjectPath: string
): Promise<ApplyResult> {
  if (source.kind !== "project") {
    return errorResult(
      "UNSUPPORTED_SOURCE",
      "Workflow source must be a project (user-scope workflows don't exist)."
    );
  }
  return applyWorkflow({
    sourceProjectPath: source.path,
    workflowKey: request.unit.key,
    targetProjectPath,
    conflict: request.conflict,
    dryRun: request.dryRun,
  });
}

async function dispatchSettings(
  request: ApplyRequest,
  source: ResolvedSource,
  targetProjectPath: string
): Promise<ApplyResult> {
  if (source.kind !== "project") {
    return errorResult(
      "UNSUPPORTED_SOURCE",
      "Settings source must be a project (user-scope settings copy not supported in V4)."
    );
  }
  return applySettings({
    settingsPath: request.unit.key,
    sourceProjectPath: source.path,
    targetProjectPath,
    conflict: request.conflict,
    dryRun: request.dryRun,
  });
}

async function dispatchPlugin(
  request: ApplyRequest,
  source: ResolvedSource,
  targetProjectPath: string
): Promise<ApplyResult> {
  if (source.kind !== "project") {
    return errorResult(
      "UNSUPPORTED_SOURCE",
      "Plugin source must be a project (user-scope plugin enables not supported in V3)."
    );
  }
  // Verify the plugin is actually enabled in the source — refuse to template
  // a disabled or unknown enable. The applyPlugin primitive itself doesn't
  // re-read the source; that's the dispatch layer's job.
  const enables = await scanProjectPluginEnables(source.path);
  const found = enables.find((e) => e.key === request.unit.key);
  if (!found) {
    return errorResult(
      "UNIT_NOT_FOUND",
      `Plugin "${request.unit.key}" is not present in the source project's enabledPlugins.`
    );
  }
  if (!found.enabled) {
    return errorResult(
      "PLUGIN_NOT_ENABLED",
      `Plugin "${request.unit.key}" is set to false in the source project — refusing to template a disabled enable.`
    );
  }
  return applyPlugin({
    pluginKey: request.unit.key,
    targetProjectPath,
    conflict: request.conflict,
    dryRun: request.dryRun,
  });
}

async function findAgent(
  unitKey: string,
  source: ResolvedSource
): Promise<AgentEntry | undefined> {
  const ctx = await loadProvenanceContext();
  if (source.kind === "user") {
    const all = await walkUserAgents(ctx);
    return all.find((a) => a.slug === unitKey);
  }
  const all = await walkProjectAgents(source.path, source.slug, ctx);
  return all.find((a) => a.slug === unitKey);
}

async function findSkill(
  unitKey: string,
  source: ResolvedSource
): Promise<SkillEntry | undefined> {
  const ctx = await loadProvenanceContext();
  // Skill keys are "<slug>:<layout>"
  const [slug, layout] = unitKey.split(":");
  const layoutMatch = (e: SkillEntry) => e.slug === slug && e.layout === layout;
  if (source.kind === "user") {
    const all = await walkUserSkills(ctx);
    return all.find(layoutMatch);
  }
  const all = await walkProjectSkills(source.path, source.slug, ctx);
  return all.find(layoutMatch);
}

async function getOrLoadScan(): Promise<ScanResult> {
  const cached = getCachedScan();
  if (cached) return cached;
  const fresh = await scanAllProjects();
  setCachedScan(fresh);
  return fresh;
}

function errorResult(code: string, message: string): ApplyResult {
  return { ok: false, status: "error", changedFiles: [], error: { code, message } };
}

// Re-export used by the API route.
export type { ApplyRequest, ApplyResult, MinderConfig };
