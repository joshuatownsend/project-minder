import { getPrimaryClaudeHome, partitionClaudeHomes, scopeMappingsToHome } from "@/lib/claudeHome";
import { normalizePathKey } from "@/lib/platform";
import { readConfig } from "@/lib/config";
import type { PathMapping } from "@/lib/types";

/**
 * The home dimension of the catalog (#553).
 *
 * A catalog walk is always over ONE Claude home. The default is this
 * machine's `~/.claude`, which is what every existing caller gets with no
 * argument and is byte-for-byte what they got before the dimension existed.
 * That default is deliberate, and differs from the issue's first sketch
 * ("iterate every readable home"): `contextOverheadComposed`, `contextBudget`,
 * `catalogLint`, `efficiencyGradeCache` and `pluginRollup` all read the
 * no-argument catalog to answer "what does THIS machine load", and
 * `template/apply.ts` walks the user roots to decide what already exists
 * before it writes — a merged multi-home default would double-count the
 * first group and could make the writer skip a skill that exists only in a
 * WSL home. One home per call also keeps entry ids collision-free without
 * qualifying them.
 *
 * A caller that wants another home names it by KEY — `normalizePathKey` of
 * the configured home path, the same string the scanner stamps on
 * `ProjectData.usageHomeKey`, which is what the group page holds for each
 * location. Resolution goes through `partitionClaudeHomes(...).readable`
 * only: a key that names a home inside a stopped WSL distro is refused with
 * the distro's reason rather than probed, because touching it would start
 * the VM (the never-wake invariant, #307/#308). Nothing derived from the
 * request string is ever handed to the filesystem.
 */
export interface CatalogHome {
  /** The configured home path (`…\.claude`), as the config wrote it. */
  path: string;
  /** `normalizePathKey(path)` — the join key. */
  key: string;
  /** This machine's own `~/.claude`. */
  primary: boolean;
  /**
   * `config.pathMappings` scoped to this home (`scopeMappingsToHome`), for
   * rewriting the plugin registry's `installPath`s — absolute in the home's
   * own filesystem — into paths this machine can open. Empty for the primary
   * home, whose registry paths are already local.
   */
  mappings: PathMapping[];
}

export type CatalogHomeProblem = "unavailable" | "unknown";

/** A `home` key that cannot be walked right now, and why. */
export class CatalogHomeError extends Error {
  readonly problem: CatalogHomeProblem;
  readonly key: string;
  /** `checkWslRoot`'s verdict when the home is configured but unreadable. */
  readonly reason?: string;
  readonly distro?: string;

  constructor(problem: CatalogHomeProblem, key: string, detail: { reason?: string; distro?: string } = {}) {
    super(
      problem === "unknown"
        ? `No configured Claude home has key '${key}'`
        : `Claude home '${key}' cannot be read this cycle${detail.reason ? ` (${detail.reason})` : ""}`
    );
    this.name = "CatalogHomeError";
    this.problem = problem;
    this.key = key;
    this.reason = detail.reason;
    this.distro = detail.distro;
  }

  /** HTTP status for the API routes: 404 for a key nobody configured, 503 for a configured home that is down. */
  get status(): 404 | 503 {
    return this.problem === "unknown" ? 404 : 503;
  }
}

export function catalogHomeKey(home: string): string {
  return normalizePathKey(home);
}

/** This machine's own home. Synchronous and config-free: the default path must cost nothing. */
export function primaryCatalogHome(): CatalogHome {
  const path = getPrimaryClaudeHome();
  return { path, key: catalogHomeKey(path), primary: true, mappings: [] };
}

/**
 * Resolve a `home` key to a walkable home, or the primary home when no key
 * (or the primary's own key) is given.
 *
 * @throws CatalogHomeError — the key names no configured home (`unknown`),
 *   or names one that `partitionClaudeHomes` reports unreadable this cycle
 *   (`unavailable`, with the reason).
 */
export async function resolveCatalogHome(homeKey?: string | null): Promise<CatalogHome> {
  const primary = primaryCatalogHome();
  if (!homeKey || homeKey === primary.key) return primary;

  const config = await readConfig();
  const { readable, unavailable } = await partitionClaudeHomes(config);
  const found = readable.find((h) => catalogHomeKey(h) === homeKey);
  if (found) {
    // `readable` lists the primary under its configured spelling too; keep the
    // primary's identity if that is what the key resolved to.
    if (catalogHomeKey(found) === primary.key) return primary;
    return {
      path: found,
      key: homeKey,
      primary: false,
      mappings: scopeMappingsToHome(found, config.pathMappings),
    };
  }
  const down = unavailable.find((u) => catalogHomeKey(u.path) === homeKey);
  if (down) throw new CatalogHomeError("unavailable", homeKey, { reason: down.reason, distro: down.distro });
  throw new CatalogHomeError("unknown", homeKey);
}
