import { promises as fs } from "fs";
import path from "path";
import type * as DatabaseT from "better-sqlite3";
import { normalizePathKey } from "@/lib/platform";

/**
 * Is the filesystem holding a Claude home case-SENSITIVE? (#416)
 *
 * ## Why this is recorded rather than inferred
 *
 * `queryByProject` keeps `project_dir_name` in its grouping identity and
 * case-folds it only for Windows-shaped (`X--`) encodings. macOS volumes are
 * case-insensitive by default, so one project recorded as both
 * `-Users-me-Dev-app` and `-users-me-dev-app` — verified against the real
 * `toSlug` to produce a single slug — stays two rows, and its cost and tokens
 * split across them. That is the same defect #236 fixed for Windows.
 *
 * The rule that would fix it is "fold POSIX paths only when the volume is
 * actually case-insensitive", and that is **not derivable at query time**: the
 * database stores an encoded path string, not the case-sensitivity of the
 * volume that produced it. Every query-time guess is wrong somewhere —
 * folding all POSIX paths merges `/home/me/Dev` and `/home/me/dev` on Linux,
 * where they really are two directories; folding only `-Users-` prefixed paths
 * does the same on any Linux box with a `/Users`, and misses macOS volumes
 * mounted elsewhere.
 *
 * So it is answered where it IS knowable — at ingest, against the live
 * filesystem — and stored per home.
 *
 * ## Why it probes by reading rather than by writing
 *
 * The obvious probe is to write `.minder-case-test` and read back
 * `.MINDER-CASE-TEST`. This does not: a Claude home can be read-only, on a
 * network share, or inside a container mount, and a probe that needs write
 * permission would answer "unknown" for exactly the setups most likely to have
 * an interesting answer — while also leaving litter in the user's home.
 *
 * Instead it takes a directory entry that already exists and asks for it under
 * a flipped case. If the flipped name resolves to the same inode, the volume
 * is case-insensitive.
 *
 * Comparing INODES, not merely "did the stat succeed": on a case-sensitive
 * volume that happens to contain both `Foo` and `foo`, the flipped name
 * resolves fine and would read as case-insensitive. Two different directory
 * entries have different inodes; one entry reached two ways has one.
 * (Windows has no meaningful `ino`, but Windows never reaches this code — the
 * `X--` encoding is folded on its own shape.)
 *
 * ## Unknown is a real answer
 *
 * `null` means "could not determine", and callers must treat it as "do not
 * fold" rather than as either verdict. An empty home, an unreadable one, a
 * home whose entries are all non-alphabetic, or a volume that has since gone
 * away all land here.
 *
 * The asymmetry is deliberate and matches the reasoning already recorded for
 * cloud-session attribution: over-merging silently combines two real projects'
 * costs into one number with no signal that it happened, while under-merging
 * splits one project into two visible rows. Splitting is the recoverable
 * error, so uncertainty resolves to the current behaviour.
 */

/** `true` case-sensitive, `false` case-insensitive, `null` undetermined. */
export type CaseSensitivity = boolean | null;

/**
 * Flip the case of a name, or return null when there is nothing to flip.
 *
 * Exported for its own test: the probe is only as good as its ability to
 * produce a genuinely different string, and a name with no cased letters
 * (`2026-03-01`, `.cache`) produces the same string — which would make every
 * probe report "case-insensitive" for the least interesting reason.
 */
export function flipCase(name: string): string | null {
  let flipped = "";
  let changed = false;
  for (const ch of name) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (lower !== upper) {
      changed = true;
      flipped += ch === lower ? upper : lower;
    } else {
      flipped += ch;
    }
  }
  return changed ? flipped : null;
}

/**
 * Probe one directory. Returns `null` when no verdict is possible.
 *
 * Reads the directory once and tries entries in order until one has a cased
 * name — several attempts rather than one, because the first entry may well be
 * `.DS_Store`-shaped or all digits.
 */
export async function probeCaseSensitivity(dir: string): Promise<CaseSensitivity> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  const present = new Set(entries);

  for (const name of entries) {
    const flipped = flipCase(name);
    if (flipped === null) continue;
    // The flipped spelling is ITSELF a real entry, so this name proves nothing:
    // both exist regardless of the volume's behaviour.
    if (present.has(flipped)) continue;

    try {
      const [original, alias] = await Promise.all([
        fs.stat(path.join(dir, name)),
        fs.stat(path.join(dir, flipped)),
      ]);
      // Same entry reached two ways → the volume ignores case.
      return !(original.ino === alias.ino && original.ino !== 0);
    } catch {
      // ENOENT on the flipped name is the case-SENSITIVE answer, and it is the
      // common one on Linux. Any other error (EACCES, a vanished entry) is
      // indistinguishable here, so try the next entry rather than concluding.
      const err = await fs
        .stat(path.join(dir, name))
        .then(() => "flipped-missing" as const)
        .catch(() => "original-missing" as const);
      if (err === "flipped-missing") return true;
      continue;
    }
  }

  return null;
}

/**
 * Read every recorded home verdict.
 *
 * Returns a map from `home_key` to `case_sensitive`, omitting homes that were
 * probed without reaching a verdict — an absent key and a NULL value both mean
 * "unknown", and collapsing them here keeps every caller from having to know
 * that `undefined` and `null` say the same thing.
 */
export function readHomeCaseSensitivity(
  db: DatabaseT.Database
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  try {
    const rows = db
      .prepare("SELECT home_key, case_sensitive FROM home_properties")
      .all() as Array<{ home_key: string; case_sensitive: number | null }>;
    for (const r of rows) {
      if (r.case_sensitive === null) continue;
      out.set(r.home_key, r.case_sensitive === 1);
    }
  } catch {
    // Table absent on a DB that predates migration 28, or unreadable. An empty
    // map reads as "nothing known", which is the safe answer everywhere.
  }
  return out;
}

/**
 * Probe each home and record the verdict.
 *
 * Called once per reconcile, not once per project: the answer is a property of
 * the volume and cannot change between two directories on it. #479's review
 * found the opposite shape — a readability verdict recomputed per project,
 * costing N filesystem round-trips per scan and N network round-trips over UNC
 * — and this is the same probe-per-home budget kept deliberately small.
 *
 * A failure to probe or to write is never fatal: the verdict is an
 * optimisation on how rows are grouped, and the report is correct without it,
 * merely split. Refusing to index because a probe failed would be strictly
 * worse than the defect.
 */
export async function recordHomeCaseSensitivity(
  db: DatabaseT.Database,
  homes: readonly string[]
): Promise<void> {
  for (const home of homes) {
    try {
      // Probe `projects/`, not the home root: it is the directory whose entries
      // become `project_dir_name`, so it is the one whose case behaviour the
      // grouping identity actually depends on. A home root and its subtree can
      // sit on different volumes (a bind-mounted or symlinked `projects/`).
      const verdict = await probeCaseSensitivity(path.join(home, "projects"));
      db.prepare(
        `INSERT INTO home_properties (home_key, case_sensitive, probed_at)
         VALUES (@home_key, @case_sensitive, @probed_at)
         ON CONFLICT(home_key) DO UPDATE SET
           case_sensitive = excluded.case_sensitive,
           probed_at = excluded.probed_at`
      ).run({
        home_key: normalizePathKey(home),
        case_sensitive: verdict === null ? null : verdict ? 1 : 0,
        probed_at: new Date().toISOString(),
      });
    } catch {
      // Next home. See above: this is never fatal.
    }
  }
}
