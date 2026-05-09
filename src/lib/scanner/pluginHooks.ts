import { promises as fs } from "fs";
import path from "path";
import { HookEntry } from "../types";
import { loadInstalledPlugins } from "../indexer/walkPlugins";
import type { InstalledPlugin } from "../indexer/types";
import { extractHookEntries } from "./claudeHooks";
import { tryParseJsonc } from "./util/jsonc";

/**
 * Read plugin-bundled hooks from each installed plugin's
 * `<installPath>/hooks/hooks.json`.
 *
 * Mirrors the shape of `readPluginScopeMcp` (pluginMcp.ts) exactly —
 * one file per plugin, fail-open per plugin, shared plugin walk.
 *
 * `installed` may be passed in by callers that already walked the
 * plugin registry (e.g. `getUserConfig` shares one walk between this
 * reader and the MCP reader); when omitted, we walk it ourselves so
 * standalone callers still work.
 */
export async function readPluginScopeHooks(
  installed?: InstalledPlugin[],
): Promise<HookEntry[]> {
  const plugins = installed ?? (await loadInstalledPlugins());
  if (plugins.length === 0) return [];

  const perPlugin = await Promise.all(
    plugins.map((p) => readOnePluginHooks(p.installPath)),
  );
  return perPlugin.flat();
}

async function readOnePluginHooks(installPath: string): Promise<HookEntry[]> {
  const file = path.join(installPath, "hooks", "hooks.json");
  try {
    const raw = await fs.readFile(file, "utf-8");
    const doc = tryParseJsonc<Record<string, unknown>>(raw);
    if (!doc) return [];
    return extractHookEntries(doc, "plugin", file);
  } catch {
    return [];
  }
}
