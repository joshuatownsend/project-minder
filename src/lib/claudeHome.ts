import { promises as fs } from "fs";
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
  // Trim trailing separators first: `...\.claude` and `...\.claude\` are the
  // same tree, and normalizePathKey preserves the trailing slash.
  const trimmed = p.trim().replace(/[\\/]+$/, "");
  const parsed = parseWslUncPath(trimmed);
  if (!parsed) return normalizePathKey(trimmed);
  const rest = normalizePathKey(
    trimmed.replace(/^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/][^\\/]+[\\/]?/i, "")
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
  return (await partitionClaudeHomes(config)).readable;
}

/** A configured Claude home that cannot be read this cycle, and why. */
export interface UnavailableClaudeHome {
  /** The configured home path, as the user wrote it. */
  path: string;
  /** The distro that is unreachable, when the home is a WSL UNC path. */
  distro?: string;
  /** `checkWslRoot`'s verdict — `wsl-stopped`, `wsl-distro-not-found`, … */
  reason: string;
}

/**
 * Split the configured homes into the ones readable right now and the ones
 * that are not, with a reason for each exclusion.
 *
 * **Why the exclusion has to be reportable (#479).** Skipping a home inside a
 * stopped WSL distro is deliberate and load-bearing — touching it would
 * auto-start the VM, which is the never-wake invariant from #307/#308. But it
 * was also SILENT, and every file-parse reader answers over readable homes
 * only, while SQLite retains rows indexed when that home was last up. So a user
 * with a distro down gets a session list and usage totals quietly missing a
 * home, with nothing saying so.
 *
 * The obvious patch — refuse the file-parse fallback when coverage cannot be
 * proven — was rejected on the issue and is worth recording here, because it
 * looks right: a stopped distro is a STEADY STATE, not a transient. A user can
 * run for weeks with one down, so that check would hold the #472 gates off
 * indefinitely for exactly the multi-home users the multi-home work was for,
 * trading a bounded first-build window for an unbounded one.
 *
 * What is done instead is to say it. Neither answer (file-parse complete over
 * readable homes, SQL partial across all of them) is right, and which is less
 * wrong depends on how much of the corpus lives in the unreachable home — a
 * judgement the user can make and Minder cannot. Reporting the fact lets the UI
 * be honest rather than choosing silently.
 *
 * Costs no extra `wsl.exe` round-trip: `checkWslRoot` was already being called
 * for every home, and its verdict was simply discarded for the excluded ones.
 */
export async function partitionClaudeHomes(
  config: MinderConfig
): Promise<{ readable: string[]; unavailable: UnavailableClaudeHome[] }> {
  const homes = getClaudeHomes(config);
  const primary = homes[0];
  const readable: string[] = [];
  const unavailable: UnavailableClaudeHome[] = [];
  for (const home of homes) {
    const wslCheck = await checkWslRoot(home);
    if (wslCheck && !wslCheck.ok) {
      unavailable.push({
        path: home,
        distro: wslCheck.distro,
        reason: wslCheck.reason,
      });
      continue;
    }
    // Passing the WSL gate is not the same as being readable (Codex P2, #510).
    // `checkWslRoot` returns `null` for a non-WSL path and `ok` for a running
    // distro WITHOUT touching the directory, so a configured home on a
    // disconnected drive, or one whose `.claude` has been moved or locked
    // down, was classified readable. The readers then catch their own
    // `readdir` failure and silently omit it — the exact incomplete-coverage
    // case this partition exists to expose, reported as `complete: true`.
    //
    // Only EXTRA homes are probed. The primary is implicit, and on a machine
    // that has never run Claude Code `~/.claude` legitimately does not exist —
    // flagging that would put a warning on every fresh install for a home the
    // user never asked for. A configured home that has vanished is a different
    // fact, and one worth telling them about.
    //
    // Probing after the WSL gate, never before: an `access` on a stopped
    // distro's UNC path is exactly the auto-wake the gate exists to prevent.
    if (home !== primary) {
      const failure = await probeHome(home);
      if (failure) {
        unavailable.push({ path: home, reason: failure });
        continue;
      }
    }
    readable.push(home);
  }
  return { readable, unavailable };
}

/**
 * `undefined` when the home can be read, otherwise a reason string.
 *
 * Checks the home directory rather than `<home>/projects`: a home that exists
 * but has recorded no sessions yet has no `projects` directory, and that is a
 * normal empty state rather than a fault. What this is looking for is a home
 * that is not there at all, or that cannot be opened.
 */
async function probeHome(home: string): Promise<string | undefined> {
  // Tolerant of a partially-mocked `fs`, the same way `platform.ts`'s
  // `fsExists` is: several suites mock only `readFile`/`readdir`/`stat`, and a
  // probe that threw there would report every configured home unavailable and
  // exclude it from the sweep. Absent means "cannot tell", and the honest
  // answer to that is the pre-probe behaviour — readable.
  if (typeof fs.access !== "function") return undefined;
  try {
    await fs.access(home);
    return undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" ? "home-missing" : "home-unreadable";
  }
}

/**
 * Just the unreadable half of {@link partitionClaudeHomes}, for callers that
 * only need to report the gap rather than read anything.
 */
export async function getUnavailableClaudeHomes(
  config: MinderConfig
): Promise<UnavailableClaudeHome[]> {
  return (await partitionClaudeHomes(config)).unavailable;
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
