import { promises as fs } from "fs";
import path from "path";
import { ApplyResult, ConflictPolicy } from "../types";
import { tryParseJsonc } from "../scanner/util/jsonc";
import { loadInstalledPlugins } from "../indexer/walkPlugins";
import {
  atomicWriteFile,
  ensureDir,
  fileExists,
  withFileLock,
} from "./atomicFs";

interface ApplyPluginArgs {
  /** "<name>@<marketplace>" or just "<name>". */
  pluginKey: string;
  /** Display name for diagnostics (defaults to pluginKey). */
  displayName?: string;
  targetProjectPath: string;
  conflict: ConflictPolicy;
  dryRun?: boolean;
}

/**
 * Flips the target project's `.claude/settings.json` `enabledPlugins[key]` to
 * `true`. Plugins live per-user at `~/.claude/plugins/`; this primitive writes
 * the *enable flag* in project settings. If the plugin isn't actually installed
 * at user scope, the apply still succeeds — but the result carries a warning
 * with a copy-pastable install hint.
 */
export async function applyPlugin(args: ApplyPluginArgs): Promise<ApplyResult> {
  const { pluginKey, displayName, targetProjectPath, conflict, dryRun } = args;
  const targetSettingsPath = path.join(targetProjectPath, ".claude", "settings.json");

  // Check user-scope install registry up front so the warning lands in the
  // dryRun preview as well as the real apply.
  const installed = await loadInstalledPlugins();
  const installedKey = (p: { pluginName: string; marketplace?: string }) =>
    p.marketplace ? `${p.pluginName}@${p.marketplace}` : p.pluginName;
  const isInstalled = installed.some((p) => installedKey(p) === pluginKey);

  const warnings: string[] = [];
  if (!isInstalled) {
    warnings.push(
      `plugin "${pluginKey}" is not installed at ~/.claude/plugins/. ` +
        `Run \`/plugin install ${pluginKey}\` in Claude Code to install it; ` +
        `the enable flag will activate automatically once it is.`
    );
  }

  return withFileLock(targetSettingsPath, async () => {
    let doc: Record<string, unknown> = {};
    if (await fileExists(targetSettingsPath)) {
      try {
        const raw = await fs.readFile(targetSettingsPath, "utf-8");
        if (raw.trim().length > 0) {
          const parsed = tryParseJsonc<Record<string, unknown>>(raw);
          if (parsed === null) {
            return errorResult(
              "MALFORMED_TARGET",
              `Target ${targetSettingsPath} is not valid JSON. Refusing to overwrite.`
            );
          }
          doc = parsed ?? {};
        }
      } catch (e) {
        return errorResult(
          "TARGET_READ_FAILED",
          `Could not read ${targetSettingsPath}: ${(e as Error).message}`
        );
      }
    }

    const enabled = (doc.enabledPlugins as Record<string, unknown> | undefined) ?? {};
    const existed = pluginKey in enabled;
    const wasTrue = enabled[pluginKey] === true;

    if (existed && wasTrue && conflict === "skip") {
      return { ok: true, status: "skipped" as const, changedFiles: [], warnings };
    }
    if (conflict === "rename") {
      return errorResult(
        "RENAME_NOT_SUPPORTED_FOR_PLUGIN",
        "Plugin enable flags cannot be renamed; use skip, overwrite, or merge."
      );
    }

    // overwrite / merge / first-write all write `true` at the key. The target
    // intent is "this plugin should be on" — flipping false → true is a merge
    // semantically (we don't want to disable an already-enabled plugin).
    const newDoc = {
      ...doc,
      enabledPlugins: { ...enabled, [pluginKey]: true },
    };
    const serialized = JSON.stringify(newDoc, null, 2) + "\n";

    if (dryRun) {
      const action = existed && wasTrue ? "[no change — already enabled]" : existed ? "[enable]" : "[add + enable]";
      const preview =
        `${action} enabledPlugins.${pluginKey}\n` +
        `target: ${targetSettingsPath}\n` +
        (displayName && displayName !== pluginKey ? `display: ${displayName}\n` : "");
      return {
        ok: true,
        status: "would-apply" as const,
        changedFiles: [targetSettingsPath],
        diffPreview: preview,
        warnings,
      };
    }

    await ensureDir(path.dirname(targetSettingsPath));
    await atomicWriteFile(targetSettingsPath, serialized);

    const status = existed && wasTrue ? "skipped" : existed && conflict === "merge" ? "merged" : "applied";
    return { ok: true, status, changedFiles: [targetSettingsPath], warnings };
  });
}

function errorResult(code: string, message: string): ApplyResult {
  return { ok: false, status: "error", changedFiles: [], error: { code, message } };
}
