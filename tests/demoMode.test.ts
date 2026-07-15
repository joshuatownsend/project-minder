import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MinderConfig } from "@/lib/types";

// Mock the config read so we can drive the `demoMode` feature flag directly.
vi.mock("@/lib/config", () => ({ readConfig: vi.fn() }));
import { readConfig } from "@/lib/config";
import { demoMode, demoModeEnv } from "@/lib/demo/demoMode";

const mockConfig = vi.mocked(readConfig);

function configWith(demoFlag: boolean | undefined): MinderConfig {
  return {
    statuses: {},
    hidden: [],
    portOverrides: {},
    devRoot: "C:\\dev",
    featureFlags: demoFlag === undefined ? {} : { demoMode: demoFlag },
  } as MinderConfig;
}

describe("demoMode toggle (env OR feature flag)", () => {
  beforeEach(() => {
    delete process.env.MINDER_DEMO;
    mockConfig.mockResolvedValue(configWith(undefined));
  });
  afterEach(() => {
    delete process.env.MINDER_DEMO;
    vi.clearAllMocks();
  });

  it("demoModeEnv() is true only for MINDER_DEMO=1", () => {
    expect(demoModeEnv()).toBe(false);
    process.env.MINDER_DEMO = "1";
    expect(demoModeEnv()).toBe(true);
    process.env.MINDER_DEMO = "0";
    expect(demoModeEnv()).toBe(false);
    process.env.MINDER_DEMO = "true"; // only "1" counts
    expect(demoModeEnv()).toBe(false);
  });

  it("is on via the env var regardless of the flag (screenshot/CI path)", async () => {
    process.env.MINDER_DEMO = "1";
    mockConfig.mockResolvedValue(configWith(false)); // flag explicitly off…
    expect(await demoMode()).toBe(true); // …env still wins
  });

  it("is on via the feature flag with no env var (live in-app toggle)", async () => {
    mockConfig.mockResolvedValue(configWith(true));
    expect(await demoMode()).toBe(true);
  });

  it("defaults OFF when neither the env var nor the flag is set (opt-in)", async () => {
    mockConfig.mockResolvedValue(configWith(undefined));
    expect(await demoMode()).toBe(false);
  });

  it("is off when the flag is explicitly false and no env var", async () => {
    mockConfig.mockResolvedValue(configWith(false));
    expect(await demoMode()).toBe(false);
  });
});
