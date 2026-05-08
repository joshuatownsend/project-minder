import { describe, it, expect, vi, beforeEach } from "vitest";
import { promisify } from "util";

// Use vi.hoisted so the exec mock is available inside vi.mock factory.
// We also attach the util.promisify.custom symbol so that promisify(exec)
// inside emergencyStop.ts returns a Promise wrapping {stdout, stderr}
// rather than the default single-value callback convention.
const { execMock } = vi.hoisted(() => {
  // require() is safe inside vi.hoisted — it runs before ESM imports resolve
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { promisify } = require("util") as typeof import("util");
  const asyncFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  const fn = vi.fn() as ReturnType<typeof vi.fn> & { [key: symbol]: unknown };
  fn[promisify.custom] = asyncFn;
  return { execMock: fn };
});

vi.mock("@/lib/tasks/spawner", () => ({
  listTrackedPids: vi.fn(() => [] as number[]),
}));

vi.mock("@/lib/platform", () => ({
  killProcessTree: vi.fn(),
  isWindows: false,
}));

vi.mock("@/lib/config", () => ({
  mutateConfig: vi.fn().mockResolvedValue(undefined),
  readConfig: vi.fn().mockResolvedValue({}),
  getDevRoots: vi.fn(() => []),
}));

vi.mock("child_process", () => ({
  exec: execMock,
  spawn: vi.fn(),
}));

import { listTrackedPids } from "@/lib/tasks/spawner";
import { killProcessTree } from "@/lib/platform";
import { mutateConfig } from "@/lib/config";
import { emergencyStop, resumeDispatcher } from "@/lib/tasks/emergencyStop";

const mockListTrackedPids = vi.mocked(listTrackedPids);
const mockKillProcessTree = vi.mocked(killProcessTree);
const mockMutateConfig = vi.mocked(mutateConfig);

// Helper to configure what execAsync resolves to per test.
// emergencyStop.ts does `const { stdout } = await execAsync(...)`.
// execMock[promisify.custom] is the function that promisify(exec) actually calls.
function setExecOutput(stdout: string) {
  const asyncFn = (execMock as unknown as Record<symbol, ReturnType<typeof vi.fn>>)[promisify.custom];
  asyncFn.mockResolvedValue({ stdout, stderr: "" });
}

beforeEach(() => {
  vi.clearAllMocks();
  setExecOutput("");
});

describe("emergencyStop", () => {
  it("returns stopped:true with zero counts when no PIDs are tracked", async () => {
    mockListTrackedPids.mockReturnValue([]);
    const result = await emergencyStop();
    expect(result.stopped).toBe(true);
    expect(result.processesKilled).toBe(0);
    expect(result.interactiveSpared).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("kills confirmed claude PIDs and sets emergencyStop flag", async () => {
    mockListTrackedPids.mockReturnValue([1234]);
    setExecOutput("claude.exe,1234,N/A,6,Running");

    const result = await emergencyStop();

    expect(mockKillProcessTree).toHaveBeenCalledWith(1234);
    expect(result.processesKilled).toBe(1);
    expect(result.interactiveSpared).toBe(0);
    expect(mockMutateConfig).toHaveBeenCalledOnce();
  });

  it("spares unconfirmed PIDs (not claude processes)", async () => {
    mockListTrackedPids.mockReturnValue([5678]);
    setExecOutput("No tasks are running with the specified criteria");

    const result = await emergencyStop();

    expect(mockKillProcessTree).not.toHaveBeenCalled();
    expect(result.processesKilled).toBe(0);
    expect(result.interactiveSpared).toBe(1);
    expect(mockMutateConfig).toHaveBeenCalledOnce();
  });

  it("includes errors array entry when killProcessTree throws", async () => {
    mockListTrackedPids.mockReturnValue([9999]);
    setExecOutput("claude.exe,9999,Running");
    mockKillProcessTree.mockImplementation(() => { throw new Error("access denied"); });

    const result = await emergencyStop();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("9999");
  });

  it("sets emergencyStop flag in config even when no PIDs", async () => {
    mockListTrackedPids.mockReturnValue([]);
    await emergencyStop();
    expect(mockMutateConfig).toHaveBeenCalledOnce();
  });
});

describe("resumeDispatcher", () => {
  it("calls mutateConfig to clear the emergencyStop flag", async () => {
    await resumeDispatcher();
    expect(mockMutateConfig).toHaveBeenCalledOnce();
  });
});
