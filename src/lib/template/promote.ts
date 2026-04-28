import { promises as fs } from "fs";
import path from "path";
import {
  MinderConfig,
  ScanResult,
  TemplateManifest,
  TemplateUnitInventory,
  TemplateUnitRef,
} from "../types";
import { scanClaudeHooks } from "../scanner/claudeHooks";
import { scanMcpServers } from "../scanner/mcpServers";
import { scanProjectPluginEnables } from "../scanner/projectPlugins";
import { walkProjectAgents } from "../indexer/walkAgents";
import { walkProjectSkills } from "../indexer/walkSkills";
import { walkProjectCommands } from "../indexer/walkCommands";
import { loadProvenanceContext } from "../indexer/provenance";
import {
  bundleDirForSlug,
  buildManifest,
  isValidSlug,
  templateDirForSlug,
  writeManifest,
} from "./manifest";
import { atomicWriteFile, copyDirRecursive, ensureDir, fileExists } from "./atomicFs";
import { templateExists } from "./registry";
import {
  explodeHookCommands,
  findHookByKey,
  findMcpByKey,
  makeHookKey,
} from "./unitKey";
import { extractHookScriptRefs } from "./applyHook";

export interface CreateLiveTemplateArgs {
  slug: string;
  name: string;
  description?: string;
  sourceSlug: string;
  units: TemplateUnitInventory;
}

/** Creates a kind="live" manifest. The source project's files are NOT copied —
 *  the manifest just points at the source slug; assets are resolved at apply
 *  time via `resolveTemplateSourcePath`. */
export async function createLiveTemplate(
  config: MinderConfig,
  scan: ScanResult,
  args: CreateLiveTemplateArgs
): Promise<{ manifest: TemplateManifest } | { error: { code: string; message: string } }> {
  if (!isValidSlug(args.slug)) {
    return { error: { code: "INVALID_SLUG", message: `"${args.slug}" is not a valid template slug.` } };
  }
  if (await templateExists(config, args.slug)) {
    return { error: { code: "SLUG_TAKEN", message: `Template "${args.slug}" already exists.` } };
  }
  const sourceProject = scan.projects.find((p) => p.slug === args.sourceSlug);
  if (!sourceProject) {
    return { error: { code: "UNKNOWN_SOURCE", message: `No project with slug "${args.sourceSlug}".` } };
  }

  const manifest = buildManifest({
    slug: args.slug,
    name: args.name,
    description: args.description,
    kind: "live",
    liveSourceSlug: args.sourceSlug,
    units: args.units,
  });
  await writeManifest(config, manifest);
  return { manifest };
}

/** Promotes a live manifest to a snapshot by copying only the *selected* units
 *  from the live source project into `<bundleDir>/`. The result mirrors a real
 *  project's `.claude/` + `.mcp.json` so the apply layer reads it uniformly.
 *
 *  Hooks: a fresh settings.json is written containing only the picked
 *  invocations, properly nested by event/matcher. Referenced hook scripts are
 *  copied into `bundle/.claude/hooks/`.
 *  MCP: a fresh .mcp.json is written containing only the picked servers,
 *  with empty-string env-key placeholders (never values — read-side invariant).
 */
export async function saveAsSnapshot(
  config: MinderConfig,
  scan: ScanResult,
  slug: string,
  liveManifest: TemplateManifest
): Promise<{ manifest: TemplateManifest } | { error: { code: string; message: string } }> {
  if (liveManifest.kind !== "live") {
    return {
      error: { code: "ALREADY_SNAPSHOT", message: `Template "${slug}" is already a snapshot.` },
    };
  }
  const sourceSlug = liveManifest.liveSourceSlug;
  if (!sourceSlug) {
    return {
      error: { code: "INVALID_LIVE_MANIFEST", message: `Live template "${slug}" has no liveSourceSlug.` },
    };
  }
  const sourceProject = scan.projects.find((p) => p.slug === sourceSlug);
  if (!sourceProject) {
    return {
      error: {
        code: "LIVE_SOURCE_MISSING",
        message: `Live source project "${sourceSlug}" no longer exists. Cannot snapshot.`,
      },
    };
  }

  const bundleDir = bundleDirForSlug(config, slug);
  // Start from a clean slate so a re-snapshot can't leak stale assets.
  await fs.rm(bundleDir, { recursive: true, force: true });
  await ensureDir(bundleDir);

  const inv = liveManifest.units;

  // Agents — single .md per agent.
  if (inv.agents.length > 0) {
    const ctx = await loadProvenanceContext();
    const all = await walkProjectAgents(sourceProject.path, sourceProject.slug, ctx);
    for (const u of inv.agents) {
      const entry = all.find((a) => a.slug === u.key);
      if (!entry) continue;
      const sourceFile = entry.realPath ?? entry.filePath;
      const targetFile = path.join(bundleDir, ".claude", "agents", `${entry.slug}.md`);
      await ensureDir(path.dirname(targetFile));
      await fs.copyFile(sourceFile, targetFile);
    }
  }

  // Skills — single .md (standalone) or directory tree (bundled).
  if (inv.skills.length > 0) {
    const ctx = await loadProvenanceContext();
    const all = await walkProjectSkills(sourceProject.path, sourceProject.slug, ctx);
    for (const u of inv.skills) {
      const [skSlug, layout] = u.key.split(":");
      const entry = all.find((s) => s.slug === skSlug && s.layout === layout);
      if (!entry) continue;
      if (entry.layout === "bundled") {
        const sourceDir = path.dirname(entry.realPath ?? entry.filePath);
        const targetDir = path.join(bundleDir, ".claude", "skills", entry.slug);
        await ensureDir(path.dirname(targetDir));
        await copyDirRecursive(sourceDir, targetDir);
      } else {
        const sourceFile = entry.realPath ?? entry.filePath;
        const targetFile = path.join(bundleDir, ".claude", "skills", `${entry.slug}.md`);
        await ensureDir(path.dirname(targetFile));
        await fs.copyFile(sourceFile, targetFile);
      }
    }
  }

  // Slash commands — single .md per command.
  if (inv.commands.length > 0) {
    const all = await walkProjectCommands(sourceProject.path, sourceProject.slug);
    for (const u of inv.commands) {
      const entry = all.find((c) => c.slug === u.key);
      if (!entry) continue;
      const sourceFile = entry.realPath ?? entry.filePath;
      const targetFile = path.join(bundleDir, ".claude", "commands", `${entry.slug}.md`);
      await ensureDir(path.dirname(targetFile));
      await fs.copyFile(sourceFile, targetFile);
    }
  }

  // Hooks + plugin enables both land in bundle/.claude/settings.json. Build a
  // single object so the second writer doesn't clobber the first.
  const bundleSettings: Record<string, unknown> = {};

  if (inv.hooks.length > 0) {
    const hooksInfo = await scanClaudeHooks(sourceProject.path);
    const allEntries = (hooksInfo?.entries ?? []).flatMap(explodeHookCommands);
    const referencedScripts = new Set<string>();
    type HooksTree = Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
    const built: HooksTree = {};

    for (const u of inv.hooks) {
      const entry = findHookByKey(allEntries, u.key);
      if (!entry) continue;
      const inv0 = entry.commands[0];
      for (const ref of extractHookScriptRefs(inv0.command)) referencedScripts.add(ref);

      const eventArr = built[entry.event] ?? [];
      let group = eventArr.find((g) => g.matcher === entry.matcher);
      if (!group) {
        group = entry.matcher ? { matcher: entry.matcher, hooks: [] } : { hooks: [] };
        eventArr.push(group);
      }
      const invocationObj: Record<string, unknown> = {
        type: inv0.type,
        command: inv0.command,
      };
      if (typeof inv0.timeout === "number") invocationObj.timeout = inv0.timeout;
      group.hooks.push(invocationObj);
      built[entry.event] = eventArr;
    }
    bundleSettings.hooks = built;

    // Copy each referenced script.
    for (const scriptName of referencedScripts) {
      const from = path.join(sourceProject.path, ".claude", "hooks", scriptName);
      if (!(await fileExists(from))) continue;
      const to = path.join(bundleDir, ".claude", "hooks", scriptName);
      await ensureDir(path.dirname(to));
      await fs.copyFile(from, to);
    }
  }

  // Plugin enables — write into the same settings.json under enabledPlugins.
  if (inv.plugins.length > 0) {
    const enables = await scanProjectPluginEnables(sourceProject.path);
    const enabledMap: Record<string, true> = {};
    for (const u of inv.plugins) {
      const e = enables.find((x) => x.key === u.key && x.enabled);
      if (!e) continue;
      enabledMap[u.key] = true;
    }
    if (Object.keys(enabledMap).length > 0) {
      bundleSettings.enabledPlugins = enabledMap;
    }
  }

  if (Object.keys(bundleSettings).length > 0) {
    const settingsFile = path.join(bundleDir, ".claude", "settings.json");
    await ensureDir(path.dirname(settingsFile));
    await atomicWriteFile(settingsFile, JSON.stringify(bundleSettings, null, 2) + "\n");
  }

  // Workflows — file-replace copies into bundle/.github/workflows/<key>.
  if (inv.workflows.length > 0) {
    for (const u of inv.workflows) {
      // Mirror applyWorkflow's traversal guard. A crafted manifest could supply
      // `..` or an absolute path; without this check, `path.join` would
      // silently let a snapshot read from / write to anywhere on disk during
      // the snapshot copy. Skip the offender rather than throwing — the
      // remaining valid units still get bundled.
      if (u.key.includes("..") || path.isAbsolute(u.key)) continue;
      const from = path.join(sourceProject.path, ".github", "workflows", u.key);
      if (!(await fileExists(from))) continue;
      const to = path.join(bundleDir, ".github", "workflows", u.key);
      await ensureDir(path.dirname(to));
      await fs.copyFile(from, to);
    }
  }

  // MCP — fresh .mcp.json with only the selected servers, env values blanked.
  if (inv.mcp.length > 0) {
    const mcpInfo = await scanMcpServers(sourceProject.path);
    const all = mcpInfo?.servers ?? [];
    const servers: Record<string, unknown> = {};
    for (const u of inv.mcp) {
      const server = findMcpByKey(all, u.key);
      if (!server) continue;
      const entry: Record<string, unknown> = {};
      if (server.transport && server.transport !== "unknown") entry.type = server.transport;
      if (server.command) entry.command = server.command;
      if (server.args && server.args.length > 0) entry.args = server.args;
      if (server.url) entry.url = server.url;
      if (server.envKeys && server.envKeys.length > 0) {
        const env: Record<string, string> = {};
        for (const k of server.envKeys) env[k] = "";
        entry.env = env;
      }
      servers[server.name] = entry;
    }
    const mcpFile = path.join(bundleDir, ".mcp.json");
    await atomicWriteFile(mcpFile, JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
  }

  // Flip the manifest to snapshot mode.
  const updated: TemplateManifest = {
    ...liveManifest,
    kind: "snapshot",
    liveSourceSlug: undefined,
    updatedAt: new Date().toISOString(),
  };
  await writeManifest(config, updated);
  return { manifest: updated };
}

export async function deleteTemplate(config: MinderConfig, slug: string): Promise<void> {
  const dir = templateDirForSlug(config, slug);
  await fs.rm(dir, { recursive: true, force: true });
}

/** Re-export for callers that compose unit keys client-side. */
export { makeHookKey };

/** Build a flat array of unit refs across kinds (used by UI for total count
 *  + iteration shortcuts). */
export function flattenInventory(inv: TemplateUnitInventory): TemplateUnitRef[] {
  return [
    ...inv.agents,
    ...inv.skills,
    ...inv.commands,
    ...inv.hooks,
    ...inv.mcp,
    ...inv.plugins,
    ...inv.workflows,
  ];
}
