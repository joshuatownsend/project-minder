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
 * The verdict rests on the DIRECTORY LISTING, not on inodes. `readdir` already
 * gave the real entries; if a flipped spelling is not among them and `stat`
 * resolves it anyway, the filesystem resolved it case-insensitively. That is
 * the whole inference, and it holds on every platform.
 *
 * An earlier version compared `Stats.ino` instead, to handle a case-sensitive
 * volume holding both `Foo` and `foo` — but `ino` is 0 on some filesystems
 * (Windows among them), which made the comparison report "case-sensitive" for
 * every volume that does not populate it, including case-INsensitive ones
 * (Copilot, PR #523). The both-spellings-exist case is already excluded by the
 * listing check above, so the inode comparison was carrying a case that could
 * not reach it while silently mis-answering ones that could. `ino` is now used
 * only to CORROBORATE, and only when both sides report a non-zero value.
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

    let alias: Awaited<ReturnType<typeof fs.stat>>;
    try {
      alias = await fs.stat(path.join(dir, flipped));
    } catch (e) {
      // ENOENT on the flipped name IS the case-sensitive answer, and it is the
      // common one on Linux.
      //
      // Anything else — EACCES, EIO on a network-mounted home, an entry that
      // vanished between the readdir and the stat — says nothing about case,
      // so it moves to the next entry. Reading every failure as ENOENT is what
      // the first version did, and it would classify a flaky network home as
      // case-sensitive on a transient error (Codex P2, PR #523).
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") continue;
      // ENOENT on the flipped name is the case-sensitive answer ONLY if the
      // original is still there. An entry deleted or renamed between the
      // `readdir` and this `stat` makes both spellings ENOENT — and reading
      // that as a verdict would record a case-INSENSITIVE home as sensitive
      // and leave its project variants split, which is the defect this file
      // exists to remove (Codex P2, PR #523).
      try {
        await fs.stat(path.join(dir, name));
      } catch {
        continue; // the entry vanished; it proves nothing
      }
      return true;
    }

    // The flipped spelling is not in the listing, yet it resolves. The
    // filesystem ignored case.
    let original: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      original = await fs.stat(path.join(dir, name));
    } catch {
      // The entry went away underneath us; this attempt proves nothing.
      continue;
    }
    // Corroborate with inodes WHEN THEY EXIST. Where both are non-zero and
    // disagree, two distinct entries are involved and the listing check missed
    // it — refuse to answer from this entry rather than answer wrongly.
    if (original.ino !== 0 && alias.ino !== 0 && original.ino !== alias.ino) {
      continue;
    }
    return false;
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
