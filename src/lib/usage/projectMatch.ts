import type { UsageTurn } from "./types";
import type { PathMapping } from "../types";
import { mapLocalPath } from "../pathMapping";

/**
 * Convert a Windows or POSIX project path to the canonical dirname
 * Claude Code uses under `~/.claude/projects/`. The encoding rule:
 * `:`, `\`, and `/` all become `-` (dots are preserved).
 * Matches the canonical `encodePath` in claudeConversations.ts.
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[:\\/]/g, "-");
}

/**
 * All encoded dirnames a project's sessions may be filed under. A UNC-scanned
 * WSL project's sessions were recorded inside the distro against the Linux
 * path, so its turns carry the foreign-encoded dirname (`-home-josh-dev-x`) —
 * `mapLocalPath` (config.pathMappings) recovers that form. Local projects
 * yield just their own encoding; the mapping seam stays in pathMapping.ts.
 */
export function projectDirNameCandidates(
  projectPath: string,
  mappings: PathMapping[] = []
): string[] {
  const names = [encodeProjectPath(projectPath)];
  const mapped = mapLocalPath(projectPath, mappings);
  if (mapped !== projectPath) {
    const enc = encodeProjectPath(mapped);
    if (!names.includes(enc)) names.push(enc);
  }
  return names;
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
  mappings: PathMapping[] = []
): UsageTurn[] {
  const expectedDirNames = projectDirNameCandidates(projectPath, mappings);
  const result: UsageTurn[] = [];
  for (const turns of sessionMap.values()) {
    if (turns.length === 0) continue;
    const head = turns[0];
    if (head.projectSlug !== slug && !expectedDirNames.includes(head.projectDirName)) continue;
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
  mappings: PathMapping[] = []
): UsageTurn[] {
  const expectedDirNames = projectDirNameCandidates(projectPath, mappings);
  const bySlugMatches = index.bySlug.get(slug) ?? [];
  const byDirMatches = expectedDirNames.flatMap((d) => index.byDirName.get(d) ?? []);
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
