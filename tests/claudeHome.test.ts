import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";
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
