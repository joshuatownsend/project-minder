import { promises as fs } from "fs";
import path from "path";
import { withFileLock } from "./atomicWrite";
import { writeFileAtomic } from "./atomicWrite";
import { recordPreWrite } from "./configHistory";
import { tryParseJsonc } from "./scanner/util/jsonc";

/**
 * Toggle a project-scope MCP server by adding or removing it from
 * `disabledMcpjsonServers` in `.claude/settings.local.json`.
 *
 * Writing to local-scope (gitignored) keeps the preference personal —
 * teammates with the same `.mcp.json` are unaffected. This matches the
 * `disabledMcpjsonServers` setting documented at
 * https://docs.claude.com/en/docs/claude-code/settings.
 *
 * `enabled = true`  → remove from disabledMcpjsonServers (re-enable)
 * `enabled = false` → add to disabledMcpjsonServers (disable)
 */
export async function toggleProjectMcpServer(
  projectPath: string,
  serverName: string,
  enabled: boolean,
): Promise<{ disabledList: string[] }> {
  const settingsPath = path.join(projectPath, ".claude", "settings.local.json");

  return withFileLock(settingsPath, async () => {
    // Read existing settings (file may not exist)
    let doc: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(settingsPath, "utf-8");
      const parsed = tryParseJsonc<Record<string, unknown>>(raw);
      if (parsed && typeof parsed === "object") doc = parsed;
    } catch {
      // File doesn't exist yet — start fresh
    }

    // Snapshot before mutation (non-fatal)
    await recordPreWrite(settingsPath, { label: "mcpToggle" }).catch(() => {});

    // Mutate disabledMcpjsonServers as a set
    const existing = Array.isArray(doc.disabledMcpjsonServers)
      ? (doc.disabledMcpjsonServers as unknown[]).filter((n): n is string => typeof n === "string")
      : [];

    const newList = enabled
      ? existing.filter((n) => n !== serverName)
      : existing.includes(serverName)
        ? existing
        : [...existing, serverName];

    const newDoc = { ...doc, disabledMcpjsonServers: newList };

    // Ensure .claude/ directory exists
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFileAtomic(settingsPath, JSON.stringify(newDoc, null, 2) + "\n");

    return { disabledList: newList };
  });
}
