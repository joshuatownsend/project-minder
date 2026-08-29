import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { flipCase, probeCaseSensitivity } from "@/lib/db/homeCaseSensitivity";

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
