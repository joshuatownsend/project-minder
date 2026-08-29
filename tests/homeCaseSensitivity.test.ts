import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  flipCase,
  probeCaseSensitivity,
  readHomeCaseSensitivity,
  recordHomeCaseSensitivity,
} from "@/lib/db/homeCaseSensitivity";
import { normalizePathKey } from "@/lib/platform";

/**
 * #416 — the volume's case-sensitivity, answered where it is knowable.
 *
 * The probe's verdict decides whether two spellings of one macOS project get
 * merged, so a wrong "case-insensitive" silently sums two real projects into
 * one number. These tests are therefore about the NEGATIVE and UNDETERMINED
 * paths at least as much as the positive one.
 */

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pm-case-"));
});

afterEach(async () => {
  try {
    await fs.rm(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("flipCase", () => {
  it("flips every cased letter", () => {
    expect(flipCase("Users-me-Dev-app")).toBe("uSERS-ME-dEV-APP");
  });

  it("returns null when there is nothing to flip", () => {
    // The probe's whole method is asking for a DIFFERENT string. A name with no
    // cased letters produces the same one, and stat'ing it would succeed on
    // every filesystem — reporting "case-insensitive" for a reason that has
    // nothing to do with the volume. Entries like these must be skipped, and
    // that starts here.
    expect(flipCase("2026-03-01")).toBeNull();
    expect(flipCase("-")).toBeNull();
    expect(flipCase("")).toBeNull();
  });

  it("flips non-ASCII letters too", () => {
    // `toSlug` uses JS `.toLowerCase()`, which is Unicode-aware, so a probe
    // that only handled ASCII would disagree with the identity it feeds.
    expect(flipCase("École")).toBe("éCOLE");
  });
});

describe("probeCaseSensitivity", () => {
  it("returns null for a directory that cannot be read", async () => {
    expect(await probeCaseSensitivity(path.join(tmp, "does-not-exist"))).toBeNull();
  });

  it("returns null for an empty directory", async () => {
    // Nothing to probe WITH. "Unknown" rather than a guess — the caller treats
    // null as "do not fold", which is the recoverable error.
    expect(await probeCaseSensitivity(tmp)).toBeNull();
  });

  it("returns null when no entry has a cased name", async () => {
    await fs.mkdir(path.join(tmp, "2026-03-01"));
    await fs.writeFile(path.join(tmp, "12345"), "x");
    expect(await probeCaseSensitivity(tmp)).toBeNull();
  });

  it("skips an entry whose flipped spelling also exists", async () => {
    // On a case-SENSITIVE volume `Foo` and `foo` can both exist, and stat'ing
    // the flipped name then succeeds — which would read as case-insensitive.
    // The entry proves nothing either way and must be passed over.
    //
    // Only meaningful where both CAN exist; on a case-insensitive volume the
    // second mkdir collides, and the test then exercises the ordinary path.
    await fs.mkdir(path.join(tmp, "Foo"));
    let bothExist = true;
    try {
      await fs.mkdir(path.join(tmp, "foo"));
    } catch {
      bothExist = false;
    }
    await fs.mkdir(path.join(tmp, "Unique-Entry"));

    const verdict = await probeCaseSensitivity(tmp);
    if (bothExist) {
      // Both spellings present means the volume kept them apart.
      expect(verdict).toBe(true);
    } else {
      expect(verdict).toBe(false);
    }
  });

  it("agrees with what the filesystem actually does", async () => {
    // The verdict is checked against a direct experiment on the SAME directory
    // rather than against the platform name. `process.platform === "darwin"`
    // says nothing about a case-sensitive APFS volume, a mounted share, or a
    // container bind-mount — and those are precisely the setups this exists
    // for. Hard-coding the platform would make this test agree with the probe
    // by sharing its assumption instead of by checking it.
    await fs.mkdir(path.join(tmp, "Dev-App"));

    let actuallyInsensitive: boolean;
    try {
      await fs.stat(path.join(tmp, "dev-app"));
      actuallyInsensitive = true;
    } catch {
      actuallyInsensitive = false;
    }

    expect(await probeCaseSensitivity(tmp)).toBe(!actuallyInsensitive);
  });
});

let driverAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

describe.skipIf(!driverAvailable)("recordHomeCaseSensitivity", () => {
  /** A throwaway in-memory DB with just the table under test. */
  async function makeDb() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    const db = new Database(":memory:");
    db.prepare(
      `CREATE TABLE home_properties (
         home_key       TEXT PRIMARY KEY,
         case_sensitive INTEGER,
         probed_at      TEXT NOT NULL
       )`
    ).run();
    return db;
  }

  it("keeps a recorded verdict when a later probe is inconclusive", async () => {
    // A transient EACCES or EIO on a network-mounted home makes the probe
    // return null. Overwriting a recorded verdict with NULL would un-fold that
    // home's projects until some later reconcile happened to succeed — a real
    // report regressing on a filesystem blip (Codex P2, PR #523).
    //
    // The main reconcile already preserves that home's SESSIONS after the same
    // listing failure, so this is about matching it rather than being the one
    // place a blip is destructive.
    const db = await makeDb();
    try {
      const home = path.join(tmp, "mac");
      const key = normalizePathKey(home);

      // A real verdict, recorded directly: this test is about the WRITE path's
      // conflict behaviour, not about re-deriving the probe's answer.
      db.prepare(
        "INSERT INTO home_properties (home_key, case_sensitive, probed_at) VALUES (?, 0, ?)"
      ).run(key, "2026-03-01T00:00:00Z");

      // `<home>/projects` does not exist, so the probe cannot conclude.
      await recordHomeCaseSensitivity(db, [home]);

      expect(readHomeCaseSensitivity(db).get(key)).toBe(false);
      // And the attempt is still recorded, so "when did we last look" stays true.
      const row = db
        .prepare("SELECT probed_at FROM home_properties WHERE home_key = ?")
        .get(key) as { probed_at: string };
      expect(row.probed_at).not.toBe("2026-03-01T00:00:00Z");
    } finally {
      db.close();
    }
  });

  it("omits an unknown home from the verdict map rather than guessing", async () => {
    const db = await makeDb();
    try {
      const home = path.join(tmp, "never-probed");
      await recordHomeCaseSensitivity(db, [home]);
      // A NULL row reads as absent: callers must not be able to tell "no row"
      // from "row with no verdict", because both mean the same thing and only
      // one of them would otherwise need handling.
      expect(readHomeCaseSensitivity(db).has(normalizePathKey(home))).toBe(false);
    } finally {
      db.close();
    }
  });
});
