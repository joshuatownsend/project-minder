import { promises as fs } from "fs";
import path from "path";
import { tryParseJsonc } from "./util/jsonc";

export interface ProjectPluginEnable {
  /** Full key as it appears in settings.enabledPlugins, e.g. "code-review@official". */
  key: string;
  /** Plugin name (left of `@`). */
  name: string;
  /** Marketplace (right of `@`); empty string when omitted. */
  marketplace: string;
  enabled: boolean;
  /** "project" (settings.json) or "local" (settings.local.json). */
  source: "project" | "local";
  sourcePath: string;
}

/** Reads `<project>/.claude/settings.json` + `settings.local.json` and returns
 *  the union of enabledPlugins entries. The latter wins on key collision so
 *  the read result mirrors how Claude Code resolves user-scope settings.local
 *  overrides. */
export async function scanProjectPluginEnables(
  projectPath: string
): Promise<ProjectPluginEnable[]> {
  const sources: { file: string; source: "project" | "local" }[] = [
    { file: ".claude/settings.json", source: "project" },
    { file: ".claude/settings.local.json", source: "local" },
  ];

  const byKey = new Map<string, ProjectPluginEnable>();

  for (const { file, source } of sources) {
    const absolute = path.join(projectPath, file);
    try {
      const raw = await fs.readFile(absolute, "utf-8");
      const doc = tryParseJsonc<{ enabledPlugins?: Record<string, unknown> }>(raw);
      const map = doc?.enabledPlugins;
      if (!map || typeof map !== "object") continue;
      for (const [key, value] of Object.entries(map)) {
        const lastAt = key.lastIndexOf("@");
        const name = lastAt > 0 ? key.slice(0, lastAt) : key;
        const marketplace = lastAt > 0 ? key.slice(lastAt + 1) : "";
        byKey.set(key, {
          key,
          name,
          marketplace,
          enabled: value === true,
          source,
          sourcePath: absolute,
        });
      }
    } catch {
      // file missing → skip
    }
  }

  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

/** Convenience: just the keys the project enables (filters out explicit `false`). */
export async function listEnabledPluginKeys(projectPath: string): Promise<string[]> {
  const all = await scanProjectPluginEnables(projectPath);
  return all.filter((e) => e.enabled).map((e) => e.key);
}
