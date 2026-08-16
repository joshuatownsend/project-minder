import "server-only";
import fs from "fs";
import path from "path";
import type DatabaseT from "better-sqlite3";
import { prepCached } from "@/lib/db/connection";
import type { FileEdit } from "@/lib/usage/fileActivity";
import { isFileWriteOp, type FileOp } from "@/lib/usage/toolNames";
import { projectDirNameCandidates } from "@/lib/usage/projectMatch";
import type { PathMapping } from "@/lib/types";

// SQL-backed source of a project's file edits, for the Hot Files and File
// Coupling routes (#439).
//
// Both routes previously ran `parseAllSessions()` — a full JSONL parse of
// EVERY session in the portfolio — and then filtered down to the one project
// being viewed. Cost therefore scaled with total history rather than with the
// project: measured cold on this machine, 190s for hot-files and 299s for
// file-coupling, against payloads of 9 KB and 16 KB. A project with a handful
// of analysed sessions still paid for all of them.
//
// The index already holds exactly what those two views need. `tool_uses`
// carries `file_path` and `file_op` per call, and its extractor is documented
// as matching `extractFileEdits`'s rule ("only args.file_path, never
// args.path"), so the same edits are recoverable with a scoped query.

/** The session-identifying columns `gatherProjectTurns` matches on. */
interface SessionRow {
  session_id: string;
  project_slug: string | null;
  project_dir_name: string | null;
  home_key: string | null;
  file_path: string | null;
  file_mtime_ms: number | null;
}

/**
 * Is the index current for THIS project's transcripts?
 *
 * A DB that opens is not a DB that has caught up. During the first reconcile,
 * or in the lag between a session being written and ingested, the index is
 * simply missing the newest work — and the callers cache their answer for five
 * minutes, so serving a partial result as authoritative shows an empty panel
 * for a project that has real edits on disk (Codex, PR #454).
 *
 * Checked against the filesystem rather than against a global watermark. The
 * tempting global test — `getDbMaxMtimeMs(db) < getJsonlMaxMtime()` — reads
 * the usage parser's in-memory FileCache, which is 0 on a cold server, so it
 * would pass precisely during the cold start it exists to catch.
 *
 * Two ways to be stale, and both matter:
 *   - a transcript on disk the index has never seen (a new session), and
 *   - a known transcript whose file is newer than the mtime recorded at ingest
 *     (an ongoing session that has grown).
 *
 * Only TOP-LEVEL `*.jsonl` files are compared. Subagent transcripts live in a
 * nested `<session-id>/subagents/` directory and are ingested as their own
 * sessions, so they legitimately appear in the index without appearing in this
 * listing; treating that as "missing from disk" would report every project
 * permanently stale.
 *
 * Cost is a readdir per project directory plus one stat per known session —
 * milliseconds against the 77s parse this replaces.
 */
/**
 * Comparison key for a path — case-folded only where the filesystem is.
 *
 * Folding everywhere was a real bug: the folded string was used for the
 * `readdirSync` call itself, and on a case-sensitive volume a home or encoded
 * directory containing any uppercase component simply does not exist under the
 * lowercased spelling. The `readdir` then threw, the catch treated it as "no
 * directory, nothing to check", and the whole guard silently passed (Codex,
 * PR #454). Filesystem calls now always use the original path; only lookups
 * use this.
 */
function pathKey(p: string): string {
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function indexIsCurrentForProject(
  matched: SessionRow[],
  candidates: ReadonlyArray<{ dirName: string }>,
  homes: string[]
): boolean {
  // `matched`, NOT every row in `sessions`. Scanning the whole table made ANY
  // un-ingested transcript anywhere in the portfolio mark EVERY project stale —
  // which on an active machine is close to permanent, and would have quietly
  // returned both routes to the 77-190s parse this change exists to remove.
  // Both reviewers caught it independently (Copilot + Codex, PR #454).
  const known = new Map<string, number>();
  // Keyed for comparison, valued with the ORIGINAL-case directory, so lookups
  // are platform-correct while filesystem calls stay verbatim.
  const dirs = new Map<string, string>();

  for (const r of matched) {
    if (!r.file_path) continue;
    const abs = path.resolve(r.file_path);
    known.set(pathKey(abs), r.file_mtime_ms ?? 0);
    const dir = path.dirname(abs);
    dirs.set(pathKey(dir), dir);
  }

  // Directories come from BOTH sources, and the union matters.
  //
  // Deriving them only from `homes` made the check a no-op whenever `homes` was
  // empty — the loop body never ran and every project reported current. Its own
  // tests caught that, which is the point of writing them: a guard that quietly
  // disables under a common configuration is worse than none, because it reads
  // as protection.
  //
  // Session file paths are the reliable source: they exist whenever the index
  // knows anything about this project, independent of configuration. `homes` is
  // still consulted, because a project whose sessions are ALL un-ingested has no
  // rows to derive a directory from — exactly the first-run case.
  for (const home of homes) {
    for (const c of candidates) {
      const dir = path.resolve(path.join(home, "projects", c.dirName));
      dirs.set(pathKey(dir), dir);
    }
  }

  for (const dir of dirs.values()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // Directory absent — not evidence of staleness.
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(dir, name);
      const recorded = known.get(pathKey(full));
      if (recorded === undefined) return false; // never ingested
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue; // Vanished mid-check; not something to block on.
      }
      // Truncated to whole ms on both sides: `file_mtime_ms` is stored as an
      // integer, while `statSync` returns a float on some platforms, and a
      // sub-millisecond difference is not staleness.
      if (Math.floor(st.mtimeMs) > Math.floor(recorded)) return false;
    }
  }
  return true;
}

/**
 * Which sessions belong to this project?
 *
 * Deliberately **not** `WHERE project_slug = ?`. The file path
 * (`gatherProjectTurns`) matches a session on slug equality **or** on an
 * encoded-dirname candidate derived from the configured path mappings and
 * Claude homes — that is what makes a WSL checkout of the same repo resolve to
 * the same project. Reducing that to a slug comparison would silently drop
 * every session recorded under a mapped path, and the route would return a
 * smaller, plausible-looking answer with nothing to signal the loss.
 *
 * So the candidate list is built by the same `projectDirNameCandidates` the
 * file path uses, and the home-key rule below mirrors `turnMatchesCandidate`:
 * an undefined home on either side means "don't care", because older rows
 * predate the column.
 *
 * The scan is one small row per session — a few thousand at most, three
 * columns wide — so it is cheap next to the tool-use query it narrows.
 */
function matchingSessionIds(
  db: DatabaseT.Database,
  slug: string,
  projectPath: string,
  mappings: PathMapping[],
  homes: string[]
): { ids: string[]; current: boolean } {
  const candidates = projectDirNameCandidates(projectPath, mappings, homes);
  // `source = 'claude'` keeps the two backends measuring the same population.
  // The fallback reads Claude homes only, via `parseAllSessions()`, so without
  // this filter a Codex or Gemini session recorded under the same slug or
  // encoded directory would appear in the indexed answer and not the file one —
  // turning these panels into mixed-harness reports whose counts change purely
  // because the DB is enabled (Codex, PR #454). Widening to other harnesses is
  // a deliberate product decision for both backends together, not a side effect
  // of a perf change.
  const rows = prepCached(
    db,
    `SELECT session_id, project_slug, project_dir_name, home_key, file_path, file_mtime_ms
       FROM sessions
      WHERE source = 'claude'`
  ).all() as SessionRow[];

  const matched: SessionRow[] = [];
  for (const r of rows) {
    if (r.project_slug === slug) {
      matched.push(r);
      continue;
    }
    const hit = candidates.some((c) => {
      if (r.project_dir_name !== c.dirName) return false;
      if (c.homeKey === undefined || r.home_key === null || r.home_key === undefined) return true;
      return r.home_key === c.homeKey;
    });
    if (hit) matched.push(r);
  }
  // Freshness is judged from the MATCHED rows, so the check answers "is this
  // project current?" rather than "is the whole portfolio current?".
  return {
    ids: matched.map((r) => r.session_id),
    current: indexIsCurrentForProject(matched, candidates, homes),
  };
}

/**
 * Write-class file edits for one project, in the shape `extractWriteEdits`
 * produces, so the aggregators consume both backends identically.
 *
 * `turnIndex` carries the transcript's real turn index here, where the file
 * path assigns the position within its own flattened array. Neither consumer
 * reads the field — `buildHotFiles` ignores it and `buildFileCoupling` groups
 * by `sessionId` — so the two remain equivalent for these routes. Stated
 * rather than silently relied upon: a future consumer that DID read it would
 * be reading two different things depending on the backend.
 */
export function loadProjectFileEditsFromDb(
  db: DatabaseT.Database,
  opts: {
    slug: string;
    projectPath: string;
    mappings?: PathMapping[];
    homes?: string[];
  }
): FileEdit[] | null {
  const { ids: sessionIds, current } = matchingSessionIds(
    db,
    opts.slug,
    opts.projectPath,
    opts.mappings ?? [],
    opts.homes ?? []
  );
  // `null`, not `[]`: the index is behind the transcripts on disk, so any
  // answer from it would be partial. `[]` is a real result meaning "this
  // project has edited no files", and conflating the two is what would show an
  // empty panel — cached for five minutes — for a project mid-ingest.
  if (!current) return null;
  if (sessionIds.length === 0) return [];

  // SQLite caps host parameters (default 999), and a portfolio can hold more
  // sessions than that, so the id list is chunked rather than bound in one
  // statement. Chunking is invisible to the result: edits are concatenated and
  // the aggregators are order-insensitive except for `lastEditTs`, which is a
  // max, and per-session insertion order, which is preserved within a chunk
  // because each session lives entirely inside one.
  const CHUNK = 500;
  const edits: FileEdit[] = [];

  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    const chunk = sessionIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    // `db.prepare`, NOT `prepCached`. The statement cache is keyed on literal
    // SQL and is unbounded by design, and `connection.ts` names this exact
    // case — "variable IN-list arity" — as one not to hand it: the final chunk
    // has a different length on almost every call, so each distinct arity
    // would be cached forever (Copilot, PR #454).
    const rows = db.prepare(
      // NO JOIN to `turns`, and the omission is measured rather than assumed.
      //
      // The obvious query joins `turns` for `ts` and for `role`/`is_sidechain`
      // guards. That join costs a primary-key descent into a 188k-row table
      // inside a 2.09 GB file for every tool-use row, and on this index it
      // measured **11.6 s against 295 ms without** — a 39x penalty on the one
      // query this issue exists to make fast.
      //
      // `tool_uses.ts` carries the same value: 0 of 78,212 rows are NULL and 0
      // disagree with `turns.ts`. The guards likewise exclude nothing — 0 rows
      // sit on a non-assistant or sidechain turn, because ingest only ever
      // writes tool uses for assistant turns.
      //
      // That last sentence is a fact about INGEST, not a database constraint,
      // so it is pinned by a test (`tests/fileActivityFromDb.test.ts`) that
      // fails if ingest ever starts writing such a row. The guard moved from a
      // per-query cost to a one-time assertion; it did not disappear.
      `SELECT tu.session_id AS sessionId,
              tu.turn_index  AS turnIndex,
              tu.file_path   AS filePath,
              tu.file_op     AS op,
              tu.ts          AS timestamp
         FROM tool_uses tu
        WHERE tu.session_id IN (${placeholders})
          AND tu.file_path IS NOT NULL
          AND tu.file_op IS NOT NULL
          AND tu.ts IS NOT NULL
        ORDER BY tu.session_id, tu.turn_index, tu.sequence_in_turn`
    ).all(...chunk) as Array<{
      sessionId: string;
      turnIndex: number;
      filePath: string;
      op: FileOp;
      timestamp: string;
    }>;

    for (const r of rows) {
      // The write-class filter that `extractWriteEdits` applies, applied here
      // through the same predicate rather than a second list of op names.
      if (!isFileWriteOp(r.op)) continue;
      edits.push({
        sessionId: r.sessionId,
        turnIndex: r.turnIndex,
        filePath: r.filePath,
        op: r.op,
        timestamp: r.timestamp,
      });
    }
  }

  return edits;
}
