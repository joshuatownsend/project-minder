import os from "os";
import path from "path";
import type { MinderConfig } from "./types";
import { normalizePathKey } from "./platform";
import { checkWslRoot } from "./wsl";

/**
 * Multi-home Claude resolution. The primary home is always this machine's
 * `~/.claude`; config.claudeHomes adds more (typically a WSL distro's
 * `\\wsl.localhost\<distro>\home\<user>\.claude`). Consumers that join
 * session data across environments iterate homes from here instead of
 * hardcoding `os.homedir()`.
 */

export function getPrimaryClaudeHome(): string {
  return path.join(os.homedir(), ".claude");
}

/** Primary home + configured extras, deduped (primary always first). */
export function getClaudeHomes(config: MinderConfig): string[] {
  const primary = getPrimaryClaudeHome();
  const homes = [primary];
  const seen = new Set([normalizePathKey(primary)]);
  for (const h of config.claudeHomes ?? []) {
    const trimmed = h.trim();
    if (!trimmed) continue;
    const key = normalizePathKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    homes.push(trimmed);
  }
  return homes;
}

/**
 * Homes that are safe to read right now. A home inside a stopped WSL distro
 * is excluded for the cycle — touching it would auto-start the VM (same
 * never-wake rule as WSL scan roots). The primary home always qualifies.
 */
export async function getReadableClaudeHomes(config: MinderConfig): Promise<string[]> {
  const readable: string[] = [];
  for (const home of getClaudeHomes(config)) {
    const wslCheck = await checkWslRoot(home);
    if (wslCheck && !wslCheck.ok) continue;
    readable.push(home);
  }
  return readable;
}
