import type { UsageTurn } from "./types";
import type { PathMapping } from "../types";
import { mapLocalPath } from "../pathMapping";
import { parseWslUncPath } from "../wsl";
import { normalizePathKey } from "../platform";

/**
 * Convert a Windows or POSIX project path to the canonical dirname
 * Claude Code uses under `~/.claude/projects/`. The encoding rule:
 * `:`, `\`, and `/` all become `-` (dots are preserved).
 * Matches the canonical `encodePath` in claudeConversations.ts.
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[:\\/]/g, "-");
}

/** One possible encoded session dirname for a project. `homeKey` is set on
 *  foreign (mapped) candidates when the producing mapping's `to` distro
 *  resolves to a configured Claude home — turns tagged with a DIFFERENT
 *  home's key then don't match, so two distros with identical path layouts
 *  (both `-home-josh-dev-x`) can't co-mingle analytics. */
export interface DirNameCandidate {
  dirName: string;
  homeKey?: string;
}

/**
 * All encoded dirnames a project's sessions may be filed under. A UNC-scanned
 * WSL project's sessions were recorded inside the distro against the Linux
 * path, so its turns carry the foreign-encoded dirname (`-home-josh-dev-x`) —
 * `mapLocalPath` (config.pathMappings) recovers that form. Local projects
 * yield just their own encoding; the mapping seam stays in pathMapping.ts.
 * Pass the configured Claude homes to pin each foreign candidate to its
 * owning home (multi-distro disambiguation).
 */
export function projectDirNameCandidates(
  projectPath: string,
  mappings: PathMapping[] = [],
  homes: string[] = []
): DirNameCandidate[] {
  const out: DirNameCandidate[] = [{ dirName: encodeProjectPath(projectPath) }];
  for (const m of mappings) {
    // Apply mappings one at a time so each foreign form is paired with the
    // mapping that produced it (mapLocalPath alone is first-match-wins).
    const mapped = mapLocalPath(projectPath, [m]);
    if (mapped === projectPath) continue;
    const dirName = encodeProjectPath(mapped);
    // Owning home = the configured home that lives UNDER the mapping's `to`
    // prefix (e.g. to=\\wsl\Ubuntu\home\bob contains home ...\home\bob\.claude).
    // Path-prefix first — two homes can share a distro (different users), and
    // a distro-level pick could pin Bob's candidate to Josh's home, making
    // turnMatchesCandidate reject every one of Bob's turns. Distro match is
    // only a fallback when it's unambiguous (exactly one home in the distro).
    const toKey = normalizePathKey(m.to);
    let home = homes.find((h) => {
      const hk = normalizePathKey(h);
      return hk === toKey || hk.startsWith(toKey + "/");
    });
    if (!home) {
      const toDistro = parseWslUncPath(m.to)?.distro.toLowerCase();
      if (toDistro) {
        const inDistro = homes.filter(
          (h) => parseWslUncPath(h)?.distro.toLowerCase() === toDistro
        );
        if (inDistro.length === 1) home = inDistro[0];
      }
    }
    const homeKey = home ? normalizePathKey(home) : undefined;
    if (!out.some((c) => c.dirName === dirName && c.homeKey === homeKey)) {
      out.push({ dirName, homeKey });
    }
  }
  return out;
}

/**
 * The home pin for a project's usage/cost REPORT identity (#311):
 * `ProjectData.usageHomeKey`. Only set when a mapping actually rewrote the
 * path (the project's sessions were recorded by a foreign home) AND that
 * mapping's owning home resolves — exactly the class where two distros with
 * identical layouts collide on `usageSlug`. Local/unmapped projects return
 * undefined so their usage requests carry no home filter (no behavior
 * change for single-home setups, and no dependency on which rows have a
 * home stamp yet).
 */
export function resolveUsageHomeKey(
  projectPath: string,
  mappings: PathMapping[] = [],
  homes: string[] = []
): string | undefined {
  const mapped = mapLocalPath(projectPath, mappings);
  if (mapped === projectPath) return undefined;
  // `usageSlug` derives from first-match-wins mapLocalPath; the candidate
  // with the SAME encoded dirname is the one produced by that winning
  // mapping, so its home pin is the report's home.
  const dirName = encodeProjectPath(mapped);
  return projectDirNameCandidates(projectPath, mappings, homes).find(
    (c) => c.dirName === dirName
  )?.homeKey;
}

/** A turn matches a candidate when the dirnames agree and neither side's
 *  home pin (if present on both) disagrees. Missing keys — older cache
 *  entries, single-session loads, local candidates — fall back to
 *  dirname-only matching. */
function turnMatchesCandidate(
  turn: UsageTurn,
  c: DirNameCandidate
): boolean {
  if (turn.projectDirName !== c.dirName) return false;
  if (c.homeKey === undefined || turn.homeKey === undefined) return true;
  return turn.homeKey === c.homeKey;
}

/**
 * Collect all UsageTurns that belong to a given project from the full
 * session map. Matches on exact slug equality OR exact encoded-dirname
 * equality to avoid substring false-positives (e.g. slug "api" matching
 * "my-api-server"). Per-session early-out: every turn in a session shares
 * the same projectSlug + projectDirName, so checking the first turn avoids
 * walking the rest for non-matching sessions.
 *
 * This scans the ENTIRE session map on every call — fine for the one-shot
 * per-request routes that call it once, but O(projects × sessions) for a
 * caller that needs turns for many projects against the same session map
 * (see `buildProjectTurnsIndex`/`lookupProjectTurns` below for that case).
 */
export function gatherProjectTurns(
  sessionMap: Map<string, UsageTurn[]>,
  slug: string,
  projectPath: string,
  mappings: PathMapping[] = [],
  homes: string[] = []
): UsageTurn[] {
  const candidates = projectDirNameCandidates(projectPath, mappings, homes);
  const result: UsageTurn[] = [];
  for (const turns of sessionMap.values()) {
    if (turns.length === 0) continue;
    const head = turns[0];
    if (head.projectSlug !== slug && !candidates.some((c) => turnMatchesCandidate(head, c))) {
      continue;
    }
    for (const t of turns) result.push(t);
  }
  return result;
}

/** One indexed session, tagged with its original position in the source
 *  session map so `lookupProjectTurns` can restore `gatherProjectTurns`'s
 *  iteration-order output exactly. */
interface IndexedSession {
  order: number;
  turns: UsageTurn[];
}

/** Built once per session map by `buildProjectTurnsIndex`; looked up per
 *  project by `lookupProjectTurns`. */
export interface ProjectTurnsIndex {
  bySlug: Map<string, IndexedSession[]>;
  byDirName: Map<string, IndexedSession[]>;
}

/**
 * Index a session map by both match keys `gatherProjectTurns` checks
 * (`projectSlug` and `projectDirName`) in a single pass, so a caller that
 * needs turns for MANY projects against the same session map (e.g. grading
 * every project in a batch) doesn't re-scan every session per project —
 * O(sessions) once instead of O(projects × sessions).
 */
export function buildProjectTurnsIndex(sessionMap: Map<string, UsageTurn[]>): ProjectTurnsIndex {
  const bySlug = new Map<string, IndexedSession[]>();
  const byDirName = new Map<string, IndexedSession[]>();
  let order = 0;

  for (const turns of sessionMap.values()) {
    if (turns.length === 0) continue;
    const head = turns[0];
    const entry: IndexedSession = { order: order++, turns };

    const slugBucket = bySlug.get(head.projectSlug);
    if (slugBucket) slugBucket.push(entry);
    else bySlug.set(head.projectSlug, [entry]);

    const dirBucket = byDirName.get(head.projectDirName);
    if (dirBucket) dirBucket.push(entry);
    else byDirName.set(head.projectDirName, [entry]);
  }

  return { bySlug, byDirName };
}

/**
 * Look up a project's turns in an index built by `buildProjectTurnsIndex`.
 * Produces the exact same set and order of turns `gatherProjectTurns` would
 * for the same `(slug, projectPath)` against the underlying session map: a
 * session matching by EITHER key is included once, and sessions are
 * concatenated in their original session-map iteration order.
 */
export function lookupProjectTurns(
  index: ProjectTurnsIndex,
  slug: string,
  projectPath: string,
  mappings: PathMapping[] = [],
  homes: string[] = []
): UsageTurn[] {
  const candidates = projectDirNameCandidates(projectPath, mappings, homes);
  const bySlugMatches = index.bySlug.get(slug) ?? [];
  const byDirMatches = candidates.flatMap((c) =>
    (index.byDirName.get(c.dirName) ?? []).filter((e) => turnMatchesCandidate(e.turns[0], c))
  );
  if (bySlugMatches.length === 0 && byDirMatches.length === 0) return [];

  const seen = new Set<number>();
  const combined: IndexedSession[] = [];
  for (const entry of bySlugMatches) {
    if (seen.has(entry.order)) continue;
    seen.add(entry.order);
    combined.push(entry);
  }
  for (const entry of byDirMatches) {
    if (seen.has(entry.order)) continue;
    seen.add(entry.order);
    combined.push(entry);
  }
  combined.sort((a, b) => a.order - b.order);

  const result: UsageTurn[] = [];
  for (const entry of combined) {
    for (const t of entry.turns) result.push(t);
  }
  return result;
}
