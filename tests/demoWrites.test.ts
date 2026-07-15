import { describe, it, expect, vi, afterEach } from "vitest";

// Detect whether the real file writer is ever invoked in demo mode (it must not
// be — demo projects have fake C:\dev paths).
vi.mock("@/lib/manualStepsWriter", () => ({ toggleStepInFile: vi.fn() }));

import { toggleStepInFile } from "@/lib/manualStepsWriter";
import { toggleManualStep, ProjectNotFoundError } from "@/lib/server/mutations/manualSteps";

const writer = vi.mocked(toggleStepInFile);

describe("demo mode is read-only (write no-op)", () => {
  afterEach(() => {
    delete process.env.MINDER_DEMO;
    vi.clearAllMocks();
  });

  it("no-ops a manual-step toggle and returns the demo project's steps unchanged", async () => {
    process.env.MINDER_DEMO = "1";
    const result = await toggleManualStep("aurora-commerce", 3);
    // aurora-commerce is a rich demo project with manual steps.
    expect(result.totalSteps).toBeGreaterThan(0);
    // The real per-file writer must never run against a fake path.
    expect(writer).not.toHaveBeenCalled();
  });

  it("still rejects an unknown slug in demo mode (found vs not-found is honest)", async () => {
    process.env.MINDER_DEMO = "1";
    await expect(toggleManualStep("no-such-project", 1)).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(writer).not.toHaveBeenCalled();
  });
});
