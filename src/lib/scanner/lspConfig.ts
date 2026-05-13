import { promises as fs } from "fs";
import path from "path";
import { tryParseJsonc } from "./util/jsonc";
import type { LspConfigInfo } from "../types";

/**
 * Reads `.claude/lsp.json` from the project directory.
 * Returns `undefined` when the file doesn't exist or can't be parsed.
 *
 * The Claude Code LSP config format is a JSON object keyed by language ID,
 * where each value describes the language server command and arguments.
 */
export async function scanLspConfig(
  projectPath: string,
): Promise<LspConfigInfo | undefined> {
  const lspPath = path.join(projectPath, ".claude", "lsp.json");

  let raw: string;
  try {
    raw = await fs.readFile(lspPath, "utf-8");
  } catch {
    return undefined;
  }

  const parsed = tryParseJsonc<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  return { sourcePath: lspPath, config: parsed };
}
