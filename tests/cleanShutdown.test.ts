import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  QUICK_CHECK_ALWAYS_MAX_BYTES,
  clearCleanShutdownMarker,
  markerPathFor,
  parseCleanShutdownMarker,
  readCleanShutdownState,
  shouldRunQuickCheck,
  writeCleanShutdownMarker,
} from "@/lib/db/cleanShutdown";

// These tests use a real temp directory rather than a mocked `fs`. The whole
// point of the marker is that it reflects on-disk truth (size, mtime, and the
// presence of a `-wal` sidecar), so mocking the filesystem would test the mock.

let dir: string;
let dbPath: string;

/** Write a fake DB file of `bytes` length. */
function writeDb(bytes: number): void {
  writeFileSync(dbPath, Buffer.alloc(bytes, 1));
}

function writeWal(bytes: number): void {
  writeFileSync(`${dbPath}-wal`, Buffer.alloc(bytes, 1));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "minder-cleanshutdown-"));
  dbPath = path.join(dir, "index.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("shouldRunQuickCheck (policy)", () => {
  it("runs the check when the last shutdown wasn't provably clean", () => {
    expect(
      shouldRunQuickCheck({ cleanShutdown: false, dbSizeBytes: 5_000_000_000 })
    ).toBe(true);
  });

  it("skips the check for a large index after a clean shutdown", () => {
    expect(
      shouldRunQuickCheck({ cleanShutdown: true, dbSizeBytes: 2_100_000_000 })
    ).toBe(false);
  });

  it("still runs the check on a small index even after a clean shutdown", () => {
    // The scan is milliseconds at this size, so skipping buys nothing and
    // costs real corruption detection.
    expect(
      shouldRunQuickCheck({ cleanShutdown: true, dbSizeBytes: 1_000_000 })
    ).toBe(true);
  });

  it("treats the size threshold as exclusive at the boundary", () => {
    expect(
      shouldRunQuickCheck({
        cleanShutdown: true,
        dbSizeBytes: QUICK_CHECK_ALWAYS_MAX_BYTES - 1,
      })
    ).toBe(true);
    expect(
      shouldRunQuickCheck({
        cleanShutdown: true,
        dbSizeBytes: QUICK_CHECK_ALWAYS_MAX_BYTES,
      })
    ).toBe(false);
  });

  it("force overrides a clean shutdown on a large index", () => {
    expect(
      shouldRunQuickCheck({
        cleanShutdown: true,
        dbSizeBytes: 5_000_000_000,
        force: true,
      })
    ).toBe(true);
  });

  it("fails toward running the check when the size is unknown (0)", () => {
    expect(shouldRunQuickCheck({ cleanShutdown: true, dbSizeBytes: 0 })).toBe(true);
  });
});

describe("readCleanShutdownState", () => {
  it("distrusts when the DB file is missing", () => {
    expect(readCleanShutdownState(dbPath)).toEqual({
      trusted: false,
      reason: "db-missing",
    });
  });

  it("distrusts when no marker was ever written", () => {
    writeDb(64);
    expect(readCleanShutdownState(dbPath)).toEqual({
      trusted: false,
      reason: "no-marker",
    });
  });

  it("trusts a marker written for the current file", () => {
    writeDb(64);
    expect(writeCleanShutdownMarker(dbPath)).toBe(true);
    expect(readCleanShutdownState(dbPath)).toEqual({
      trusted: true,
      reason: "trusted",
    });
  });

  it("distrusts once the DB has been written to (size changed)", () => {
    writeDb(64);
    writeCleanShutdownMarker(dbPath);
    writeDb(128);
    expect(readCleanShutdownState(dbPath).reason).toBe("db-changed");
  });

  it("distrusts when only the mtime moved, at identical size", () => {
    // The in-place-rewrite case: a crash can leave the file the same length
    // but with different bytes, so size alone is not a sufficient binding.
    writeDb(64);
    writeCleanShutdownMarker(dbPath);
    const future = new Date(Date.now() + 60_000);
    utimesSync(dbPath, future, future);
    expect(readCleanShutdownState(dbPath).reason).toBe("db-changed");
  });

  it("distrusts a non-empty WAL even when the marker matches perfectly", () => {
    // The independent signal: a non-empty WAL means the graceful path (which
    // truncates it) did not complete, whatever the marker claims.
    writeDb(64);
    writeCleanShutdownMarker(dbPath);
    expect(readCleanShutdownState(dbPath).trusted).toBe(true);
    writeWal(4096);
    expect(readCleanShutdownState(dbPath)).toEqual({
      trusted: false,
      reason: "wal-not-empty",
    });
  });

  it("tolerates a zero-length WAL as drained", () => {
    writeDb(64);
    writeCleanShutdownMarker(dbPath);
    writeWal(0);
    expect(readCleanShutdownState(dbPath).trusted).toBe(true);
  });

  it("distrusts an unparseable marker", () => {
    writeDb(64);
    writeFileSync(markerPathFor(dbPath), "{ not json");
    expect(readCleanShutdownState(dbPath).reason).toBe("unreadable-marker");
  });

  it("distrusts a marker from a future schema version", () => {
    writeDb(64);
    const st = statSync(dbPath);
    writeFileSync(
      markerPathFor(dbPath),
      JSON.stringify({
        version: 99,
        closedAt: new Date().toISOString(),
        dbSize: st.size,
        dbMtimeMs: st.mtimeMs,
      })
    );
    expect(readCleanShutdownState(dbPath).reason).toBe("version-mismatch");
  });

  it("does not consume the marker on read", () => {
    // Two processes open this DB at boot (server + ingest worker). Both must
    // be able to take the fast path; consume-on-read would make the second
    // pay the full scan for no added safety.
    writeDb(64);
    writeCleanShutdownMarker(dbPath);
    expect(readCleanShutdownState(dbPath).trusted).toBe(true);
    expect(readCleanShutdownState(dbPath).trusted).toBe(true);
    expect(readCleanShutdownState(dbPath).trusted).toBe(true);
  });
});

describe("writeCleanShutdownMarker", () => {
  it("refuses to write a marker for a DB that doesn't exist", () => {
    expect(writeCleanShutdownMarker(dbPath)).toBe(false);
  });
});

describe("clearCleanShutdownMarker", () => {
  it("removes the marker so a rebuilt index can't inherit the old claim", () => {
    writeDb(64);
    writeCleanShutdownMarker(dbPath);
    clearCleanShutdownMarker(dbPath);
    expect(readCleanShutdownState(dbPath).reason).toBe("no-marker");
  });

  it("is a no-op when no marker is present", () => {
    writeDb(64);
    expect(() => clearCleanShutdownMarker(dbPath)).not.toThrow();
  });
});

describe("parseCleanShutdownMarker", () => {
  const valid = {
    version: 1,
    closedAt: "2026-08-17T11:00:00.000Z",
    dbSize: 64,
    dbMtimeMs: 1_700_000_000_000,
  };

  it("accepts a well-formed marker", () => {
    expect(parseCleanShutdownMarker(JSON.stringify(valid))).toEqual(valid);
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   "],
    ["invalid json", "{"],
    ["json array", "[]"],
    ["json null", "null"],
    ["missing version", JSON.stringify({ ...valid, version: undefined })],
    ["string version", JSON.stringify({ ...valid, version: "1" })],
    ["missing closedAt", JSON.stringify({ ...valid, closedAt: undefined })],
    ["string dbSize", JSON.stringify({ ...valid, dbSize: "64" })],
    ["NaN dbMtimeMs", JSON.stringify({ ...valid, dbMtimeMs: "x" })],
  ])("rejects %s", (_label, input) => {
    expect(parseCleanShutdownMarker(input)).toBeNull();
  });

  it("rejects null and undefined input", () => {
    expect(parseCleanShutdownMarker(null)).toBeNull();
    expect(parseCleanShutdownMarker(undefined)).toBeNull();
  });
});
