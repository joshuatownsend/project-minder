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
import os from "os";
import { walkProjectCommands, walkUserCommands } from "../indexer/walkCommands";
import { walkProjectAgents, walkUserAgents } from "../indexer/walkAgents";
import { walkProjectSkills, walkUserSkills } from "../indexer/walkSkills";
import { loadProvenanceContext } from "../indexer/provenance";
import { getUserConfig } from "../userConfigCache";
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
import { recordPreWrite, removeBackup, type BackupId } from "../configHistory";

/** Snapshot every target file before a non-dryRun apply mutates it.
 *  Returns the recorded BackupIds so callers can roll them back if the
 *  apply primitive turns out to be a no-op. Failure to snapshot is
 *  logged inside recordPreWrite and returns null — never blocks the
 *  apply (a missing backup is unfortunate, an aborted apply is worse).
 *
 *  Bundled-skill applies write whole directories and are intentionally
 *  skipped (per Wave 1.2 scope — directory backups are a separate
 *  retention problem).
 *
 *  Slug resolution: for `target.kind === "existing"` we use the
 *  existing slug; for `target.kind === "path"` we look it up in the
 *  cached scan so snapshots from `applyTemplate` (which routes
 *  bootstrapped projects through the path branch) still surface in
 *  `/api/config-history?project=<slug>` filtered queries. Returns
 *  undefined slug for paths that don't match a scanned project — those
 *  snapshots still record under the global manifest, just unscoped. */
async function snapshotBeforeApply(
  request: ApplyRequest,
  targetFiles: string[],
): Promise<BackupId[]> {
  if (request.dryRun) return [];
  const projectSlug = await resolveProjectSlugForSnapshot(request.target);
  const label = `apply-${request.unit.kind}:${request.unit.key}`;
  const ids: BackupId[] = [];
  for (const f of targetFiles) {
    const id = await recordPreWrite(f, { projectSlug, label });
    if (id) ids.push(id);
  }
  return ids;
}

async function resolveProjectSlugForSnapshot(
  target: ApplyTarget,
): Promise<string | undefined> {
  if (target.kind === "existing") return target.slug;
  if (target.kind === "path") {
    const scan = await getOrLoadScan();
    return scan.projects.find((p) => p.path === target.path)?.slug;
  }
  return undefined;
}

/** Roll back snapshots when an apply primitive turned out to be a
 *  no-op (skipped, would-apply, or errored). The snapshot was recorded
 *  before we knew the apply's verdict; without rollback, the manifest
 *  fills with misleading "restore points" for events that didn't
 *  change disk — bloating prune work and confusing the Config History
 *  tab. Rollback failures are swallowed inside removeBackup. */
async function finalizeSnapshots<T extends ApplyResult>(
  ids: BackupId[],
  result: T,
): Promise<T> {
  if (ids.length === 0) return result;
  const wroteToDisk =
    result.ok && (result.status === "applied" || result.status === "merged");
  if (!wroteToDisk) {
    await Promise.all(ids.map((id) => removeBackup(id)));
  }
  return result;
}

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
  const snaps = await snapshotBeforeApply(request, [targetFile]);
  return finalizeSnapshots(snaps, await applySingleFile({
    sourcePath: sourceFile,
    targetPath: targetFile,
    conflict: request.conflict,
    dryRun: request.dryRun,
  }));
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
    // Bundled skills write a directory tree — directory snapshots are
    // out of scope for Wave 1.2 (TODO #56 covers files only).
    return applyDirectory({
      sourceDir,
      targetDir,
      conflict: request.conflict,
      dryRun: request.dryRun,
    });
  }
  const sourceFile = entry.realPath ?? entry.filePath;
  const targetFile = path.join(targetProjectPath, ".claude", "skills", `${entry.slug}.md`);
  const snaps = await snapshotBeforeApply(request, [targetFile]);
  return finalizeSnapshots(snaps, await applySingleFile({
    sourcePath: sourceFile,
    targetPath: targetFile,
    conflict: request.conflict,
    dryRun: request.dryRun,
  }));
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
  const snaps = await snapshotBeforeApply(request, [targetFile]);
  return finalizeSnapshots(snaps, await applySingleFile({
    sourcePath: sourceFile,
    targetPath: targetFile,
    conflict: request.conflict,
    dryRun: request.dryRun,
  }));
}

async function dispatchHook(
  request: ApplyRequest,
  source: ResolvedSource,
  targetProjectPath: string
): Promise<ApplyResult> {
  let allEntries: HookEntry[];
  let sourceHooksDir: string;
  let sourceRootForRejection: string;

  if (source.kind === "user") {
    const userCfg = await getUserConfig();
    allEntries = userCfg.hooks.entries;
    const userClaude = path.join(os.homedir(), ".claude");
    sourceHooksDir = path.join(userClaude, "hooks");
    // Reject literal absolute paths into ~/.claude (would break in any other
    // user's checkout). We don't reject `~` itself — that's the user's home
    // dir and may legitimately appear in hook commands like `cd ~/.bashrc`.
    sourceRootForRejection = userClaude;
  } else {
    const hooksInfo = await scanClaudeHooks(source.path);
    allEntries = hooksInfo?.entries ?? [];
    sourceHooksDir = path.join(source.path, ".claude", "hooks");
    sourceRootForRejection = source.path;
  }

  const exploded = allEntries.flatMap(explodeHookCommands);
  const entry = findHookByKey(exploded, request.unit.key);
  if (!entry) return errorResult("UNIT_NOT_FOUND", `Hook "${request.unit.key}" not found in source.`);

  const snaps = await snapshotBeforeApply(request, [
    path.join(targetProjectPath, ".claude", "settings.json"),
  ]);
  return finalizeSnapshots(snaps, await applyHook({
    entry,
    sourceHooksDir,
    sourceRootForRejection,
    targetProjectPath,
    conflict: request.conflict,
    dryRun: request.dryRun,
  }));
}

async function dispatchMcp(
  request: ApplyRequest,
  source: ResolvedSource,
  targetProjectPath: string
): Promise<ApplyResult> {
  let all: McpServer[];
  let sourceSlug: string | undefined;

  if (source.kind === "user") {
    const userCfg = await getUserConfig();
    all = userCfg.mcpServers.servers;
    sourceSlug = "user";
  } else {
    const mcpInfo = await scanMcpServers(source.path);
    all = mcpInfo?.servers ?? [];
    sourceSlug = source.slug;
  }

  const server = findMcpByKey(all, request.unit.key);
  if (!server) return errorResult("UNIT_NOT_FOUND", `MCP server "${request.unit.key}" not found in source.`);

  const snaps = await snapshotBeforeApply(request, [path.join(targetProjectPath, ".mcp.json")]);
  return finalizeSnapshots(snaps, await applyMcp({
    server,
    targetProjectPath,
    conflict: request.conflict,
    sourceSlug,
    dryRun: request.dryRun,
  }));
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
  const snaps = await snapshotBeforeApply(request, [
    path.join(targetProjectPath, ".github", "workflows", request.unit.key),
  ]);
  return finalizeSnapshots(snaps, await applyWorkflow({
    sourceProjectPath: source.path,
    workflowKey: request.unit.key,
    targetProjectPath,
    conflict: request.conflict,
    dryRun: request.dryRun,
  }));
}

async function dispatchSettings(
  request: ApplyRequest,
  source: ResolvedSource,
  targetProjectPath: string
): Promise<ApplyResult> {
  const sourceSettingsFile =
    source.kind === "user"
      ? path.join(os.homedir(), ".claude", "settings.json")
      : path.join(source.path, ".claude", "settings.json");

  const snaps = await snapshotBeforeApply(request, [
    path.join(targetProjectPath, ".claude", "settings.json"),
  ]);
  return finalizeSnapshots(snaps, await applySettings({
    settingsPath: request.unit.key,
    sourceSettingsFile,
    targetProjectPath,
    conflict: request.conflict,
    sourceScope: source.kind === "user" ? "user" : "project",
    dryRun: request.dryRun,
  }));
}

async function dispatchPlugin(
  request: ApplyRequest,
  source: ResolvedSource,
  targetProjectPath: string
): Promise<ApplyResult> {
  // Verify the plugin is actually enabled in the source — refuse to template
  // a disabled or unknown enable. The applyPlugin primitive itself doesn't
  // re-read the source; that's the dispatch layer's job.
  let isEnabled = false;
  let isPresent = false;
  if (source.kind === "user") {
    const userCfg = await getUserConfig();
    const found = userCfg.plugins.plugins.find((p) => {
      const key = p.marketplace ? `${p.name}@${p.marketplace}` : p.name;
      return key === request.unit.key;
    });
    isPresent = !!found;
    isEnabled = !!found?.enabled;
  } else {
    const enables = await scanProjectPluginEnables(source.path);
    const found = enables.find((e) => e.key === request.unit.key);
    isPresent = !!found;
    isEnabled = !!found?.enabled;
  }

  if (!isPresent) {
    return errorResult(
      "UNIT_NOT_FOUND",
      source.kind === "user"
        ? `Plugin "${request.unit.key}" is not present in the user's enabledPlugins.`
        : `Plugin "${request.unit.key}" is not present in the source project's enabledPlugins.`
    );
  }
  if (!isEnabled) {
    return errorResult(
      "PLUGIN_NOT_ENABLED",
      `Plugin "${request.unit.key}" is set to false in the source — refusing to template a disabled enable.`
    );
  }
  const snaps = await snapshotBeforeApply(request, [
    path.join(targetProjectPath, ".claude", "settings.json"),
  ]);
  return finalizeSnapshots(snaps, await applyPlugin({
    pluginKey: request.unit.key,
    targetProjectPath,
    conflict: request.conflict,
    sourceScope: source.kind === "user" ? "user" : "project",
    dryRun: request.dryRun,
  }));
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
