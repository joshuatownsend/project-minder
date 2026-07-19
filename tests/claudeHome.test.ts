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
import { getPrimaryClaudeHome, getClaudeHomes, getReadableClaudeHomes } from "@/lib/claudeHome";

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
