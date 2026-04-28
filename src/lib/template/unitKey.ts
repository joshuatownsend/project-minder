import { createHash } from "crypto";
import { HookEntry, McpServer } from "../types";

/**
 * Stable per-kind identity keys used by the apply API to address a unit
 * deterministically. Keys must be filesystem-safe and survive serialization.
 *
 * Hooks fold the command into the key so re-applying never produces a
 * duplicate at the same `event+matcher` — a single matcher can carry many
 * commands, and identity has to discriminate them.
 */

export function agentKey(slug: string): string {
  return slug;
}

export function skillKey(slug: string, layout: "bundled" | "standalone"): string {
  return `${slug}:${layout}`;
}

export function commandKey(slug: string): string {
  return slug;
}

export function hookKey(entry: { event: string; matcher?: string; commands: { command: string }[] }): string {
  // One command per key — for entries with multiple commands, callers must
  // expand into per-command refs (the apply layer handles this).
  const cmd = entry.commands[0]?.command ?? "";
  return makeHookKey(entry.event, entry.matcher, cmd);
}

export function makeHookKey(event: string, matcher: string | undefined, command: string): string {
  const m = matcher ?? "*";
  const sha = sha256(command).slice(0, 16);
  return `${event}|${m}|${sha}`;
}

export function mcpKey(server: { name: string }): string {
  return server.name;
}

/** Expand a HookEntry with N commands into N HookEntry-like singletons, each
 *  with one command. The single-command shape is what the apply layer writes;
 *  the source scanner emits multi-command entries because that's how settings
 *  files are authored.
 */
export function explodeHookCommands(entry: HookEntry): HookEntry[] {
  if (entry.commands.length <= 1) return [entry];
  return entry.commands.map((c) => ({ ...entry, commands: [c] }));
}

/** Re-find a single-command HookEntry inside a list of multi-command entries by key. */
export function findHookByKey(entries: HookEntry[], key: string): HookEntry | undefined {
  for (const e of entries) {
    for (const c of e.commands) {
      if (makeHookKey(e.event, e.matcher, c.command) === key) {
        return { ...e, commands: [c] };
      }
    }
  }
  return undefined;
}

/** Re-find an McpServer by name. */
export function findMcpByKey(servers: McpServer[], key: string): McpServer | undefined {
  return servers.find((s) => s.name === key);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
