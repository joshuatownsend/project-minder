import os from "os";
import path from "path";
import type { MinderConfig, PathMapping } from "./types";
import { normalizePathKey } from "./platform";
import { checkWslRoot, parseWslUncPath } from "./wsl";

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

/**
 * Dedupe key that treats WSL's two UNC hosts as the same tree:
 * `\\wsl$\Ubuntu\home\josh\.claude` and `\\wsl.localhost\Ubuntu\home\josh\.claude`
 * are aliases for one filesystem, and letting both through would parse the
 * same history.jsonl twice and double-count every session. Non-WSL paths
 * fall back to the plain normalized key.
 */
function homeDedupeKey(p: string): string {
  const parsed = parseWslUncPath(p);
  if (!parsed) return normalizePathKey(p);
  const rest = normalizePathKey(
    p.trim().replace(/^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/][^\\/]+[\\/]?/i, "")
  );
  return `wsl://${parsed.distro.toLowerCase()}/${rest.toLowerCase()}`;
}

/** Primary home + configured extras, deduped (primary always first; WSL
 *  `wsl$`/`wsl.localhost` aliases collapse to one entry). */
export function getClaudeHomes(config: MinderConfig): string[] {
  const primary = getPrimaryClaudeHome();
  const homes = [primary];
  const seen = new Set([homeDedupeKey(primary)]);
  for (const h of config.claudeHomes ?? []) {
    const trimmed = h.trim();
    if (!trimmed) continue;
    const key = homeDedupeKey(trimmed);
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

/**
 * The mappings that may be applied when correlating THROUGH a given Claude
 * home. Two WSL distros can share a foreign prefix (Ubuntu and Debian both
 * recording `/home/josh/...`); a mapping whose `to` targets one distro must
 * not rewrite history read from the other distro's home, or sessions get
 * attributed across distros. A WSL-targeted mapping is scoped to the home
 * under the same distro; non-WSL mappings apply everywhere.
 */
export function scopeMappingsToHome(
  home: string,
  mappings: PathMapping[] | undefined
): PathMapping[] {
  if (!mappings || mappings.length === 0) return [];
  const homeDistro = parseWslUncPath(home)?.distro.toLowerCase();
  return mappings.filter((m) => {
    const toDistro = parseWslUncPath(m.to)?.distro.toLowerCase();
    if (!toDistro) return true; // non-WSL mapping — no distro to scope by
    return toDistro === homeDistro;
  });
}
