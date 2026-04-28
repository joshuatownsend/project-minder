import path from "path";
import {
  ApplyRequest,
  ApplyResult,
  HookEntry,
  McpServer,
  MinderConfig,
  ProjectData,
  ScanResult,
} from "../types";
import { readConfig } from "../config";
import { getCachedScan, setCachedScan, invalidateCache as invalidateScanCache } from "../cache";
import { scanAllProjects } from "../scanner";
import { scanClaudeHooks } from "../scanner/claudeHooks";
import { scanMcpServers } from "../scanner/mcpServers";
import { invalidateCatalogCache } from "../indexer/catalog";
import { invalidateClaudeConfigRouteCache } from "@/app/api/claude-config/route";
import { walkProjectCommands, walkUserCommands } from "../indexer/walkCommands";
import { walkProjectAgents, walkUserAgents } from "../indexer/walkAgents";
import { walkProjectSkills, walkUserSkills } from "../indexer/walkSkills";
import { loadProvenanceContext } from "../indexer/provenance";
import type { AgentEntry, SkillEntry } from "../indexer/types";
import { applySingleFile, applyDirectory } from "./applyFile";
import { applyHook } from "./applyHook";
import { applyMcp } from "./applyMcp";
import { ensureInsideDevRoots, PathSafetyError } from "./pathSafety";
import { explodeHookCommands, findHookByKey, findMcpByKey } from "./unitKey";

/**
 * Top-level orchestrator. Resolves source + target paths, dispatches to the
 * right primitive, and (on a successful non-dryRun) invalidates the caches
 * that the dashboard / browsers read from.
 */
export async function applyUnit(request: ApplyRequest): Promise<ApplyResult> {
  const config = await readConfig();
  const scan = await getOrLoadScan();

  // Resolve target project path.
  if (request.target.kind !== "existing") {
    return errorResult(
      "UNSUPPORTED_TARGET",
      `V1 only supports target.kind="existing"; got "${request.target.kind}".`
    );
  }
  const targetProject = scan.projects.find((p) => p.slug === request.target.slug);
  if (!targetProject) {
    return errorResult("UNKNOWN_TARGET_PROJECT", `No project with slug "${request.target.slug}".`);
  }

  let safeTargetPath: string;
  try {
    safeTargetPath = ensureInsideDevRoots(targetProject.path, config);
  } catch (e) {
    if (e instanceof PathSafetyError) {
      return errorResult(e.code, e.message);
    }
    throw e;
  }

  // Dispatch by unit kind.
  let result: ApplyResult;
  try {
    switch (request.unit.kind) {
      case "agent":
        result = await dispatchAgent(request, safeTargetPath, scan);
        break;
      case "skill":
        result = await dispatchSkill(request, safeTargetPath, scan);
        break;
      case "command":
        result = await dispatchCommand(request, safeTargetPath, scan);
        break;
      case "hook":
        result = await dispatchHook(request, targetProject, scan);
        break;
      case "mcp":
        result = await dispatchMcp(request, targetProject, scan);
        break;
      default:
        result = errorResult("UNKNOWN_UNIT_KIND", `Unsupported unit kind "${request.unit.kind}".`);
    }
  } catch (e) {
    result = errorResult("APPLY_THREW", (e as Error).message);
  }

  // Invalidate caches on a successful, non-dryRun apply.
  if (result.ok && !request.dryRun && result.status !== "skipped") {
    invalidateScanCache();
    invalidateCatalogCache();
    invalidateClaudeConfigRouteCache();
  }

  return result;
}

async function dispatchAgent(
  request: ApplyRequest,
  targetProjectPath: string,
  scan: ScanResult
): Promise<ApplyResult> {
  const entry = await findAgent(request, scan);
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
  targetProjectPath: string,
  scan: ScanResult
): Promise<ApplyResult> {
  const entry = await findSkill(request, scan);
  if (!entry) return errorResult("UNIT_NOT_FOUND", `Skill "${request.unit.key}" not found in source.`);

  if (entry.layout === "bundled") {
    // Bundled skills live as a directory containing SKILL.md.
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
  targetProjectPath: string,
  scan: ScanResult
): Promise<ApplyResult> {
  const source = request.source;
  if (source.kind === "user") {
    const entries = await walkUserCommands();
    const entry = entries.find((e) => e.slug === request.unit.key);
    if (!entry) return errorResult("UNIT_NOT_FOUND", `User command "${request.unit.key}" not found.`);
    const sourceFile = entry.realPath ?? entry.filePath;
    const targetFile = path.join(targetProjectPath, ".claude", "commands", `${entry.slug}.md`);
    return applySingleFile({
      sourcePath: sourceFile,
      targetPath: targetFile,
      conflict: request.conflict,
      dryRun: request.dryRun,
    });
  }
  // source.kind === "project"
  const sourceProject = scan.projects.find((p) => p.slug === source.slug);
  if (!sourceProject) {
    return errorResult("UNKNOWN_SOURCE_PROJECT", `No project with slug "${source.slug}".`);
  }
  const entries = await walkProjectCommands(sourceProject.path, sourceProject.slug);
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
  targetProject: ProjectData,
  scan: ScanResult
): Promise<ApplyResult> {
  const source = request.source;
  if (source.kind !== "project") {
    return errorResult("UNSUPPORTED_SOURCE", "Hook source must be a project (user-scope hooks not supported in V1).");
  }
  const sourceProject = scan.projects.find((p) => p.slug === source.slug);
  if (!sourceProject) {
    return errorResult("UNKNOWN_SOURCE_PROJECT", `No project with slug "${source.slug}".`);
  }

  const hooksInfo = await scanClaudeHooks(sourceProject.path);
  const allEntries: HookEntry[] = hooksInfo?.entries ?? [];
  // Expand multi-command entries into single-command entries so key lookup matches.
  const exploded = allEntries.flatMap(explodeHookCommands);
  const entry = findHookByKey(exploded, request.unit.key);
  if (!entry) return errorResult("UNIT_NOT_FOUND", `Hook "${request.unit.key}" not found in source.`);

  return applyHook({
    entry,
    sourceProjectPath: sourceProject.path,
    targetProjectPath: targetProject.path,
    conflict: request.conflict,
    dryRun: request.dryRun,
  });
}

async function dispatchMcp(
  request: ApplyRequest,
  targetProject: ProjectData,
  scan: ScanResult
): Promise<ApplyResult> {
  const source = request.source;
  if (source.kind !== "project") {
    return errorResult("UNSUPPORTED_SOURCE", "MCP source must be a project in V1.");
  }
  const sourceProject = scan.projects.find((p) => p.slug === source.slug);
  if (!sourceProject) {
    return errorResult("UNKNOWN_SOURCE_PROJECT", `No project with slug "${source.slug}".`);
  }

  const mcpInfo = await scanMcpServers(sourceProject.path);
  const all: McpServer[] = mcpInfo?.servers ?? [];
  const server = findMcpByKey(all, request.unit.key);
  if (!server) return errorResult("UNIT_NOT_FOUND", `MCP server "${request.unit.key}" not found in source.`);

  return applyMcp({
    server,
    targetProjectPath: targetProject.path,
    conflict: request.conflict,
    sourceSlug: sourceProject.slug,
    dryRun: request.dryRun,
  });
}

async function findAgent(
  request: ApplyRequest,
  scan: ScanResult
): Promise<AgentEntry | undefined> {
  const ctx = await loadProvenanceContext();
  const source = request.source;
  if (source.kind === "user") {
    const all = await walkUserAgents(ctx);
    return all.find((a) => a.slug === request.unit.key);
  }
  const sourceProject = scan.projects.find((p) => p.slug === source.slug);
  if (!sourceProject) return undefined;
  const all = await walkProjectAgents(sourceProject.path, sourceProject.slug, ctx);
  return all.find((a) => a.slug === request.unit.key);
}

async function findSkill(
  request: ApplyRequest,
  scan: ScanResult
): Promise<SkillEntry | undefined> {
  const ctx = await loadProvenanceContext();
  // Skill keys are "<slug>:<layout>"
  const [slug, layout] = request.unit.key.split(":");
  const layoutMatch = (e: SkillEntry) => e.slug === slug && e.layout === layout;
  const source = request.source;
  if (source.kind === "user") {
    const all = await walkUserSkills(ctx);
    return all.find(layoutMatch);
  }
  const sourceProject = scan.projects.find((p) => p.slug === source.slug);
  if (!sourceProject) return undefined;
  const all = await walkProjectSkills(sourceProject.path, sourceProject.slug, ctx);
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
