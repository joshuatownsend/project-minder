import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `isFirstRun` asks two questions: does `.minder.json` exist (fs.access), and
// does any candidate dev root exist (probeDefaultDevRoot). Mock both seams.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: actual,
    promises: { ...actual.promises, access: vi.fn() },
  };
});

vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, probeDefaultDevRoot: vi.fn() };
});

const { promises: fsp } = await import("fs");
const { probeDefaultDevRoot } = await import("@/lib/platform");
const { isFirstRun } = await import("@/lib/config");

const access = vi.mocked(fsp.access);
const probe = vi.mocked(probeDefaultDevRoot);

describe("isFirstRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is true when there is no config file AND no candidate root exists", async () => {
    access.mockRejectedValue(new Error("ENOENT"));
    probe.mockReturnValue(null);
    expect(await isFirstRun()).toBe(true);
  });

  it("is false when a candidate root exists — nothing to ask, just scan it", async () => {
    access.mockRejectedValue(new Error("ENOENT"));
    probe.mockReturnValue("C:\\dev");
    expect(await isFirstRun()).toBe(false);
  });

  // The regression that matters most: someone who completed setup must never
  // be dropped back into it, even if their configured root is unreachable
  // right now (unplugged drive, stopped WSL distro).
  it("is false when a config file exists, even with no candidate root", async () => {
    access.mockResolvedValue(undefined);
    probe.mockReturnValue(null);
    expect(await isFirstRun()).toBe(false);
  });

  it("does not even probe the filesystem when a config file exists", async () => {
    access.mockResolvedValue(undefined);
    probe.mockReturnValue(null);
    await isFirstRun();
    expect(probe).not.toHaveBeenCalled();
  });
});
