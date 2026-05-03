import { promises as fs } from "fs";
import path from "path";
import { ApplyResult, ConflictPolicy, McpServer } from "../types";
import { tryParseJsonc } from "../scanner/util/jsonc";
import {
  atomicWriteFile,
  fileExists,
  withFileLock,
} from "./atomicFs";

interface ApplyMcpArgs {
  /** Indexed McpServer. Apply must NEVER re-read the raw source `.mcp.json`
   *  to avoid leaking env values that the read-side stripped. */
  server: McpServer;
  targetProjectPath: string;
  conflict: ConflictPolicy;
  /** Optional source slug used to construct rename suffix on conflict. */
  sourceSlug?: string;
  dryRun?: boolean;
}

/**
 * Merge an MCP server entry into the target's `.mcp.json`. Env values are
 * never copied — only env *key names* are preserved as empty-string
 * placeholders, matching the read-side invariant in `scanMcpServers`.
 */
export async function applyMcp(args: ApplyMcpArgs): Promise<ApplyResult> {
  const { server, targetProjectPath, conflict, sourceSlug, dryRun } = args;
  const targetMcpPath = path.join(targetProjectPath, ".mcp.json");
  const warnings: string[] = [];
  // Read-only sources MUST NOT be promoted into a project's .mcp.json.
  // Why: `local`/`plugin`/`desktop`/`managed` originate from files
  // Project Minder reads but never writes. Promoting them would either
  // duplicate state (local/plugin) or escape sandbox boundaries
  // (desktop/managed). Surface as a typed error rather than a silent
  // write so a misuse fails loudly at the closest sensible boundary.
  if (server.source !== "user" && server.source !== "project") {
    return errorResult(
      "UNSUPPORTED_MCP_SOURCE_FOR_APPLY",
      `MCP source "${server.source}" is read-only in Project Minder. Only "user" and "project" sources can be applied.`
    );
  }
  if (server.source === "user") {
    warnings.push(
      "user-scope source promoted to project-shared (.mcp.json) — will apply to anyone using this repo"
    );
  }

  return withFileLock(targetMcpPath, async () => {
    let doc: Record<string, unknown> = {};
    if (await fileExists(targetMcpPath)) {
      try {
        const raw = await fs.readFile(targetMcpPath, "utf-8");
        if (raw.trim().length > 0) {
          const parsed = tryParseJsonc<Record<string, unknown>>(raw);
          if (parsed === null) {
            return errorResult(
              "MALFORMED_TARGET",
              `Target ${targetMcpPath} is not valid JSON. Refusing to overwrite.`
            );
          }
          doc = parsed ?? {};
        }
      } catch (e) {
        return errorResult(
          "TARGET_READ_FAILED",
          `Could not read ${targetMcpPath}: ${(e as Error).message}`
        );
      }
    }

    const servers = (doc.mcpServers as Record<string, unknown> | undefined) ?? {};
    let targetName = server.name;
    const existed = Object.prototype.hasOwnProperty.call(servers, server.name);

    if (existed) {
      if (conflict === "skip") {
        return { ok: true, status: "skipped", changedFiles: [], warnings };
      }
      if (conflict === "rename") {
        const suffix = sourceSlug ? `-from-${sourceSlug}` : "-copy";
        targetName = pickRenamedKey(servers, `${server.name}${suffix}`);
      }
      // "merge" and "overwrite" both replace at the named key — there is no
      // sub-structure worth merging beyond what the McpServer shape encodes.
    }

    const entry: Record<string, unknown> = {};
    if (server.transport && server.transport !== "unknown") entry.type = server.transport;
    if (server.command) entry.command = server.command;
    if (server.args && server.args.length > 0) entry.args = server.args;
    if (server.url) entry.url = server.url;
    if (server.envKeys && server.envKeys.length > 0) {
      const envObj: Record<string, string> = {};
      for (const k of server.envKeys) envObj[k] = "";
      entry.env = envObj;
      warnings.push(
        `${server.envKeys.length} env value${server.envKeys.length === 1 ? "" : "s"} to fill in: ` +
          server.envKeys.join(", ")
      );
    }

    const newDoc = {
      ...doc,
      mcpServers: { ...servers, [targetName]: entry },
    };
    const serialized = JSON.stringify(newDoc, null, 2) + "\n";

    if (dryRun) {
      const action = existed
        ? conflict === "rename"
          ? `[rename + add] ${server.name} → ${targetName}`
          : "[overwrite]"
        : "[add]";
      const preview =
        `${action} mcpServers.${targetName}\n` +
        `transport: ${server.transport}\n` +
        (server.command ? `command: ${server.command}${server.args ? " " + server.args.join(" ") : ""}\n` : "") +
        (server.url ? `url: ${server.url}\n` : "") +
        (server.envKeys && server.envKeys.length > 0 ? `env keys: ${server.envKeys.join(", ")}\n` : "");
      return {
        ok: true,
        status: "would-apply",
        changedFiles: [targetMcpPath],
        diffPreview: preview,
        warnings,
      };
    }

    await atomicWriteFile(targetMcpPath, serialized);
    const status = existed && conflict === "merge" ? "merged" : "applied";
    return { ok: true, status, changedFiles: [targetMcpPath], warnings };
  });
}

function pickRenamedKey(servers: Record<string, unknown>, base: string): string {
  if (!Object.prototype.hasOwnProperty.call(servers, base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!Object.prototype.hasOwnProperty.call(servers, candidate)) return candidate;
  }
  throw new Error(`Cannot find unused MCP name based on ${base}`);
}

function errorResult(code: string, message: string): ApplyResult {
  return { ok: false, status: "error", changedFiles: [], error: { code, message } };
}
