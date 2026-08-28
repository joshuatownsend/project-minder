import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { removeTempHome } from "./_helpers/isolatedState";
import type { MinderConfig } from "@/lib/types";
import type { WslRootCheck } from "@/lib/wsl";

// Keep parseWslUncPath real (pure/sync — homeDedupeKey needs it) but stub
// checkWslRoot so readability gating never spawns wsl.exe in tests.
vi.mock("@/lib/wsl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/wsl")>();
  return { ...actual, checkWslRoot: vi.fn() };
});

import { checkWslRoot } from "@/lib/wsl";
import {
  getPrimaryClaudeHome,
  getClaudeHomes,
  getReadableClaudeHomes,
  partitionClaudeHomes,
  getUnavailableClaudeHomes,
  resetClaudeHomeProbeCache,
} from "@/lib/claudeHome";

const mockCheckWslRoot = vi.mocked(checkWslRoot);

const PRIMARY = path.join(os.homedir(), ".claude");
const WSL_HOME = "\\\\wsl.localhost\\Ubuntu-26.04\\home\\josh\\.claude";

function cfg(overrides: Partial<MinderConfig> = {}): MinderConfig {
  return { statuses: {}, hidden: [], portOverrides: {}, devRoot: "C:\\dev", pinnedSlugs: [], ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckWslRoot.mockResolvedValue(null);
  // The probe memoises per home path for 30s. Without this, a case that
  // creates a temp home and a later one that reuses the name would read the
  // first verdict — and the cache-reuse test below would pass by accident.
  resetClaudeHomeProbeCache();
});

describe("getClaudeHomes", () => {
  it("returns only the primary home by default", () => {
    expect(getClaudeHomes(cfg())).toEqual([PRIMARY]);
  });

  it("appends configured extras after the primary", () => {
    expect(getClaudeHomes(cfg({ claudeHomes: [WSL_HOME] }))).toEqual([PRIMARY, WSL_HOME]);
  });

  it("dedupes extras against the primary and each other", () => {
    const homes = getClaudeHomes(cfg({ claudeHomes: [PRIMARY, WSL_HOME, WSL_HOME, "  "] }));
    expect(homes).toEqual([PRIMARY, WSL_HOME]);
  });
});

describe("getReadableClaudeHomes", () => {
  it("keeps homes whose WSL distro is running (and non-WSL homes)", async () => {
    mockCheckWslRoot.mockImplementation(async (root: string): Promise<WslRootCheck | null> =>
      root === WSL_HOME ? { ok: true, distro: "Ubuntu-26.04" } : null
    );
    expect(await getReadableClaudeHomes(cfg({ claudeHomes: [WSL_HOME] }))).toEqual([PRIMARY, WSL_HOME]);
  });

  it("excludes a home inside a stopped distro for the cycle (never wakes it)", async () => {
    mockCheckWslRoot.mockImplementation(async (root: string): Promise<WslRootCheck | null> =>
      root === WSL_HOME ? { ok: false, distro: "Ubuntu-26.04", reason: "wsl-stopped" } : null
    );
    expect(await getReadableClaudeHomes(cfg({ claudeHomes: [WSL_HOME] }))).toEqual([PRIMARY]);
  });
});

// #479 — the exclusion above is deliberate and load-bearing (never-wake), and
// it was also SILENT. Every file-parse reader answers over readable homes only
// while SQLite retains rows indexed when the home was last up, so totals
// quietly disagree with themselves and nothing says why. These pin that the
// reason survives to a caller that wants to report it.
describe("partitionClaudeHomes (#479)", () => {
  const STOPPED: WslRootCheck = {
    ok: false,
    distro: "Ubuntu-26.04",
    reason: "wsl-stopped",
  };

  it("reports the excluded home, with its distro and reason", async () => {
    mockCheckWslRoot.mockImplementation(async (root: string) =>
      root === WSL_HOME ? STOPPED : null
    );
    const { readable, unavailable } = await partitionClaudeHomes(
      cfg({ claudeHomes: [WSL_HOME] })
    );
    expect(readable).toEqual([PRIMARY]);
    expect(unavailable).toEqual([
      { path: WSL_HOME, distro: "Ubuntu-26.04", reason: "wsl-stopped" },
    ]);
  });

  it("reports nothing when every home answers", async () => {
    mockCheckWslRoot.mockImplementation(async (root: string) =>
      root === WSL_HOME ? { ok: true, distro: "Ubuntu-26.04" } : null
    );
    const { readable, unavailable } = await partitionClaudeHomes(
      cfg({ claudeHomes: [WSL_HOME] })
    );
    expect(readable).toEqual([PRIMARY, WSL_HOME]);
    expect(unavailable).toEqual([]);
  });

  it("distinguishes a missing distro from a stopped one", async () => {
    // The banner says different things for these, so collapsing them to a
    // single "unavailable" would be a downgrade in what the user is told.
    mockCheckWslRoot.mockImplementation(async (root: string) =>
      root === WSL_HOME
        ? { ok: false, distro: "Ubuntu-26.04", reason: "wsl-distro-not-found" }
        : null
    );
    const unavailable = await getUnavailableClaudeHomes(
      cfg({ claudeHomes: [WSL_HOME] })
    );
    expect(unavailable[0].reason).toBe("wsl-distro-not-found");
  });

  it("keeps getReadableClaudeHomes exactly equal to the readable half", async () => {
    // The old function is now a projection of the new one. If they ever
    // diverge, every existing caller's never-wake guarantee is at stake --
    // which is the one property here that must not be refactored loose.
    mockCheckWslRoot.mockImplementation(async (root: string) =>
      root === WSL_HOME ? STOPPED : null
    );
    const config = cfg({ claudeHomes: [WSL_HOME] });
    expect(await getReadableClaudeHomes(config)).toEqual(
      (await partitionClaudeHomes(config)).readable
    );
  });

  it("does not probe a home more than once", async () => {
    // The whole reason this costs nothing: `checkWslRoot` was ALREADY called
    // for every home and its verdict discarded for the excluded ones. If the
    // partition ever probed twice it would double the wsl.exe round-trips on
    // a path whose entire purpose is not touching WSL.
    mockCheckWslRoot.mockImplementation(async (root: string) =>
      root === WSL_HOME ? STOPPED : null
    );
    await partitionClaudeHomes(cfg({ claudeHomes: [WSL_HOME] }));
    expect(mockCheckWslRoot).toHaveBeenCalledTimes(2); // primary + the WSL home
  });
});

// #479 round 2 (Codex P2 on PR #510) — passing the WSL gate is not the same as
// being readable. `checkWslRoot` returns null for a non-WSL path and `ok` for a
// running distro WITHOUT touching the directory, so a configured home on a
// disconnected drive was classified readable, the readers caught their own
// `readdir` failure and silently omitted it, and the endpoint reported
// `complete: true` — the exact case the partition exists to expose.
describe("partitionClaudeHomes probes extra homes for real (#479)", () => {
  const EXTRA = path.join(os.tmpdir(), "pm-home-that-is-not-there");

  it("reports a configured home that does not exist", async () => {
    const { unavailable } = await partitionClaudeHomes(
      cfg({ claudeHomes: [EXTRA] })
    );
    expect(unavailable).toEqual([{ path: EXTRA, reason: "home-missing" }]);
  });

  it("keeps a configured home that does exist", async () => {
    const real = await fs.mkdtemp(path.join(os.tmpdir(), "pm-home-real-"));
    try {
      const { readable, unavailable } = await partitionClaudeHomes(
        cfg({ claudeHomes: [real] })
      );
      expect(unavailable).toEqual([]);
      expect(readable).toContain(real);
    } finally {
      await removeTempHome(real);
    }
  });

  it("reports a home that exists but is not a directory", async () => {
    // `fs.access` defaults to F_OK and succeeds here, which is how the first
    // version of this probe called a regular file a readable home (Codex P2,
    // PR #510). Opening it is the question the readers actually ask.
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), "pm-home-file-"));
    const asFile = path.join(dirPath, "not-a-home");
    await fs.writeFile(asFile, "", "utf-8");
    try {
      const { unavailable } = await partitionClaudeHomes(
        cfg({ claudeHomes: [asFile] })
      );
      expect(unavailable).toEqual([
        { path: asFile, reason: "home-not-a-directory" },
      ]);
    } finally {
      await removeTempHome(dirPath);
    }
  });

  it("reports a projects/ directory that exists but cannot be listed", async () => {
    // The depth that matters: `buildAllSessions` and `scanAllSessions`
    // enumerate `<home>/projects`, so a home that opens while its `projects`
    // is a regular file is exactly the silent-omission case, one level below
    // where the previous probe stopped (Codex P2, PR #510).
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "pm-home-badproj-"));
    try {
      await fs.writeFile(path.join(home, "projects"), "", "utf-8");
      const { readable, unavailable } = await partitionClaudeHomes(
        cfg({ claudeHomes: [home] })
      );
      expect(readable).not.toContain(home);
      expect(unavailable).toEqual([
        { path: home, reason: "projects-not-a-directory" },
      ]);
    } finally {
      await removeTempHome(home);
    }
  });

  it("probes each home once per window, not once per caller", async () => {
    // `getReadableClaudeHomes` is called once per PROJECT during a scan, so an
    // unmemoised probe added N filesystem round-trips per scan — over UNC to a
    // WSL distro, N network round-trips (Codex P2, PR #510).
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "pm-home-cached-"));
    try {
      const first = await partitionClaudeHomes(cfg({ claudeHomes: [home] }));
      expect(first.unavailable).toEqual([]);

      // Break the home AFTER the first probe. Within the window the verdict is
      // reused, which is the observable form of "it did not look again".
      await removeTempHome(home);
      const second = await partitionClaudeHomes(cfg({ claudeHomes: [home] }));
      expect(second.unavailable).toEqual([]);

      // And it is a cache, not a permanent answer.
      resetClaudeHomeProbeCache();
      const third = await partitionClaudeHomes(cfg({ claudeHomes: [home] }));
      expect(third.unavailable).toEqual([
        { path: home, reason: "home-missing" },
      ]);
    } finally {
      await removeTempHome(home);
    }
  });

  it("does not require a projects/ directory", async () => {
    // A home that exists but has recorded nothing yet is a normal empty state,
    // not a fault. Probing `<home>/projects` instead would flag every home
    // before its first session.
    const real = await fs.mkdtemp(path.join(os.tmpdir(), "pm-home-empty-"));
    try {
      const { unavailable } = await partitionClaudeHomes(
        cfg({ claudeHomes: [real] })
      );
      expect(unavailable).toEqual([]);
    } finally {
      await removeTempHome(real);
    }
  });

  it("forgives an ABSENT primary home, because a fresh install has none", async () => {
    // On a machine that has never run Claude Code, `~/.claude` legitimately
    // does not exist. Warning about that would fire on every fresh install for
    // a home the user never configured.
    const spy = vi.spyOn(os, "homedir").mockReturnValue(
      path.join(os.tmpdir(), "pm-home-never-used")
    );
    try {
      const { readable, unavailable } = await partitionClaudeHomes(cfg());
      expect(unavailable).toEqual([]);
      expect(readable).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("still reports an UNREADABLE primary home", async () => {
    // The counterpart, and the reason the rule forgives one outcome rather
    // than skipping the check: a primary that exists but cannot be listed
    // omits the MAIN corpus, and is the last thing that should be silent.
    // An earlier draft skipped the primary's probe entirely and suppressed
    // this too (Codex P2, PR #510).
    const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), "pm-home-prim-"));
    const asFile = path.join(dirPath, "primary-is-a-file");
    await fs.writeFile(asFile, "", "utf-8");
    const spy = vi.spyOn(os, "homedir").mockReturnValue(dirPath);
    try {
      // `getPrimaryClaudeHome()` joins `.claude` onto the home, so point the
      // spy at a directory whose `.claude` IS the regular file above.
      await fs.rename(asFile, path.join(dirPath, ".claude"));
      const { readable, unavailable } = await partitionClaudeHomes(cfg());
      expect(readable).toEqual([]);
      expect(unavailable).toEqual([
        {
          path: path.join(dirPath, ".claude"),
          reason: "home-not-a-directory",
        },
      ]);
    } finally {
      spy.mockRestore();
      await removeTempHome(dirPath);
    }
  });

  it("checks WSL BEFORE touching the filesystem", async () => {
    // An `access` on a stopped distro's UNC path is exactly the auto-wake the
    // gate exists to prevent, so a stopped home must be reported by its WSL
    // reason and never reach the probe.
    mockCheckWslRoot.mockImplementation(async (root: string) =>
      root === WSL_HOME
        ? { ok: false, distro: "Ubuntu-26.04", reason: "wsl-stopped" }
        : null
    );
    const { unavailable } = await partitionClaudeHomes(
      cfg({ claudeHomes: [WSL_HOME] })
    );
    expect(unavailable).toEqual([
      { path: WSL_HOME, distro: "Ubuntu-26.04", reason: "wsl-stopped" },
    ]);
  });
});
