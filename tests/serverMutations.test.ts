import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import path from "path";

// ── mocks (hoisted before the modules-under-test import them) ─────────────────
vi.mock("@/lib/projectPath", () => ({ findProjectPathBySlug: vi.fn() }));
vi.mock("@/lib/manualStepsWriter", () => ({ toggleStepInFile: vi.fn() }));
vi.mock("@/lib/cache", () => ({ invalidateCache: vi.fn() }));
vi.mock("@/lib/config", () => ({ mutateConfig: vi.fn() }));
vi.mock("@/app/api/claude-config/route", () => ({
  invalidateClaudeConfigRouteCache: vi.fn(),
}));

import { findProjectPathBySlug } from "@/lib/projectPath";
import { toggleStepInFile } from "@/lib/manualStepsWriter";
import { invalidateCache } from "@/lib/cache";
import { mutateConfig } from "@/lib/config";
import { invalidateClaudeConfigRouteCache } from "@/app/api/claude-config/route";
import {
  toggleManualStep,
  ProjectNotFoundError,
} from "@/lib/server/mutations/manualSteps";
import { setProjectStatus } from "@/lib/server/mutations/projectStatus";
import { FEATURE_FLAG_META, getFlag } from "@/lib/featureFlags";
import type { ManualStepsInfo, MinderConfig } from "@/lib/types";

const mockFindPath = findProjectPathBySlug as unknown as Mock;
const mockToggle = toggleStepInFile as unknown as Mock;
const mockInvalidateCache = invalidateCache as unknown as Mock;
const mockMutateConfig = mutateConfig as unknown as Mock;
const mockInvalidateClaude = invalidateClaudeConfigRouteCache as unknown as Mock;

const EMPTY_INFO: ManualStepsInfo = {
  entries: [],
  totalSteps: 0,
  pendingSteps: 0,
  completedSteps: 0,
};

beforeEach(() => vi.clearAllMocks());

// ── toggleManualStep ─────────────────────────────────────────────────────────
describe("toggleManualStep", () => {
  it("throws ProjectNotFoundError when the slug resolves to no project", async () => {
    mockFindPath.mockResolvedValue(null);
    await expect(toggleManualStep("ghost", 3)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    expect(mockToggle).not.toHaveBeenCalled();
    expect(mockInvalidateCache).not.toHaveBeenCalled();
  });

  it("toggles the step in the project's MANUAL_STEPS.md and invalidates the cache", async () => {
    mockFindPath.mockResolvedValue("C:\\dev\\minder");
    const updated: ManualStepsInfo = { ...EMPTY_INFO, totalSteps: 1, completedSteps: 1 };
    mockToggle.mockResolvedValue(updated);

    const result = await toggleManualStep("minder", 7);

    expect(mockToggle).toHaveBeenCalledWith(
      path.join("C:\\dev\\minder", "MANUAL_STEPS.md"),
      7,
    );
    expect(mockInvalidateCache).toHaveBeenCalledOnce();
    expect(result).toBe(updated);
  });

  it("rejects a non-numeric lineNumber before touching the filesystem", async () => {
    await expect(
      toggleManualStep("minder", "3" as unknown as number),
    ).rejects.toBeInstanceOf(TypeError);
    expect(mockFindPath).not.toHaveBeenCalled();
  });
});

// ── setProjectStatus ─────────────────────────────────────────────────────────
describe("setProjectStatus", () => {
  it("persists statuses[slug]=status and invalidates both caches", async () => {
    // Run the mutator against a fake config to prove it writes the right key.
    const cfg = { statuses: {} as Record<string, string> } as unknown as MinderConfig;
    mockMutateConfig.mockImplementation(async (fn: (c: MinderConfig) => void) => {
      fn(cfg);
      return cfg;
    });

    await setProjectStatus("minder", "paused");

    expect(cfg.statuses.minder).toBe("paused");
    expect(mockInvalidateCache).toHaveBeenCalledOnce();
    expect(mockInvalidateClaude).toHaveBeenCalledOnce();
  });
});

// ── flag default (Settings toggle vs client gate parity) ─────────────────────
describe("serverActions is opt-in (default off)", () => {
  it("meta marks defaultOn:false so the Settings toggle matches the client gate", () => {
    const meta = FEATURE_FLAG_META.find((m) => m.key === "serverActions");
    expect(meta?.defaultOn).toBe(false);
    // Client callers read getFlag(flags, "serverActions", false): absent → off.
    expect(getFlag({}, "serverActions", meta?.defaultOn ?? true)).toBe(false);
    expect(getFlag(undefined, "serverActions", false)).toBe(false);
    // Explicit on is honoured.
    expect(getFlag({ serverActions: true }, "serverActions", false)).toBe(true);
  });
});
