import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { McpServer } from "../types";
import { parseMcpServers } from "./mcpServers";
import { tryParseJsonc } from "./util/jsonc";

export interface ClaudeJsonMcpExtract {
  /** Top-level `mcpServers` from ~/.claude.json — Claude Code "user" scope. */
  user: McpServer[];
  /** Per-project `mcpServers` from `projects[<path>].mcpServers` —
   *  Claude Code "local" scope. Keyed on the project path string exactly
   *  as Claude Code stores it (typically an absolute path). */
  byProject: Map<string, McpServer[]>;
}

const CLAUDE_JSON_FILENAME = ".claude.json";

/**
 * Read `~/.claude.json` and extract ONLY the MCP server blocks.
 *
 * SECURITY: `~/.claude.json` is owned by Claude Code itself and contains
 * OAuth tokens, telemetry IDs, and other sensitive runtime state. This
 * function MUST NOT return, log, or retain the parsed document root.
 * It extracts `mcpServers` (user scope) and `projects[<path>].mcpServers`
 * (local scope) into typed `McpServer[]` shapes — every other field is
 * dropped before returning so it cannot leak through caches, the API
 * layer, or rendered UI. The parser itself (`parseMcpServers`) already
 * strips env *values* and keeps only key names.
 *
 * The safety guarantee covers the *returned* object's contents — the
 * parsed root is dropped before return, so logging or stringifying the
 * returned `ClaudeJsonMcpExtract` is safe. Future code that logs the raw
 * parsed doc inside this function would defeat the guarantee.
 *
 * Fails open on ENOENT / EACCES / malformed JSON: returns empty extract.
 * Claude Code recreates this file on next launch, so a missing or broken
 * read should never block Project Minder's read path.
 */
export async function readClaudeJsonMcp(): Promise<ClaudeJsonMcpExtract> {
  const filePath = path.join(os.homedir(), CLAUDE_JSON_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return { user: [], byProject: new Map() };
  }

  const doc = tryParseJsonc<{
    mcpServers?: unknown;
    projects?: Record<string, unknown>;
  }>(raw);
  if (!doc || typeof doc !== "object") {
    return { user: [], byProject: new Map() };
  }

  const user = parseMcpServers(doc.mcpServers, "user", filePath);

  const byProject = new Map<string, McpServer[]>();
  if (doc.projects && typeof doc.projects === "object") {
    for (const [projectPath, projectDoc] of Object.entries(doc.projects)) {
      if (!projectDoc || typeof projectDoc !== "object") continue;
      const mcpField = (projectDoc as { mcpServers?: unknown }).mcpServers;
      const servers = parseMcpServers(mcpField, "local", filePath);
      if (servers.length > 0) byProject.set(projectPath, servers);
    }
  }

  return { user, byProject };
}

/** Convenience: just the user-scope list. Equivalent to
 *  `(await readClaudeJsonMcp()).user`, exported so callers that only
 *  want one slice don't need to construct the unused Map. */
export async function readUserScopeMcpFromClaudeJson(): Promise<McpServer[]> {
  const { user } = await readClaudeJsonMcp();
  return user;
}

/** Convenience: local-scope list for one project path. Returns `[]` if
 *  Claude Code has no entry for that path.
 *
 *  Path matching is normalized so trailing separators and separator
 *  variants resolve to the same key. (Drive-letter case on Windows is
 *  NOT folded — `C:\` and `c:\` would still mismatch — but Claude Code
 *  is consistent within a single install, so this is the pragmatic
 *  boundary.) */
export async function readLocalScopeMcpFromClaudeJson(
  projectPath: string,
): Promise<McpServer[]> {
  const { byProject } = await readClaudeJsonMcp();
  const target = canonicalizePathKey(projectPath);
  for (const [storedPath, servers] of byProject) {
    if (canonicalizePathKey(storedPath) === target) return servers;
  }
  return [];
}

function canonicalizePathKey(p: string): string {
  const normalized = path.normalize(p);
  // path.normalize preserves trailing separators — strip them so
  // "C:\dev\proj" and "C:\dev\proj\" compare equal. Don't strip the
  // separator if it's the entire string (e.g. root "/").
  if (normalized.length > 1 && normalized.endsWith(path.sep)) {
    return normalized.slice(0, -1);
  }
  return normalized;
}
