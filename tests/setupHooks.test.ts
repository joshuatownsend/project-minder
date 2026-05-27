import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  existsSync: vi.fn(),
}));

import * as fs from "fs";
import { setupHooks } from "../scripts/setup-hooks.mjs";

const HOOK = `#!/bin/sh\n# Run type-check and tests before committing\npnpm typecheck && pnpm test --pool=forks\n`;
const TARGET = "/fake/.git/hooks/pre-commit";

describe("setupHooks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it("writes hook when file does not exist", () => {
    const result = setupHooks({ hookPath: TARGET });

    expect(result.written).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalledWith(TARGET, HOOK, "utf8");
    expect(fs.chmodSync).toHaveBeenCalledWith(TARGET, 0o755);
  });

  it("is idempotent when hook already matches", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(HOOK);

    const result = setupHooks({ hookPath: TARGET });

    expect(result.written).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("updates hook when content differs from expected", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("#!/bin/sh\nold hook\n");

    const result = setupHooks({ hookPath: TARGET });

    expect(result.written).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalledWith(TARGET, HOOK, "utf8");
  });

  it("dry run reports would-write but does not touch the file", () => {
    const result = setupHooks({ hookPath: TARGET, dryRun: true });

    expect(result.written).toBe(true);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.chmodSync).not.toHaveBeenCalled();
  });

  it("returns the resolved hook path", () => {
    const result = setupHooks({ hookPath: TARGET });
    expect(result.path).toBe(TARGET);
  });
});
