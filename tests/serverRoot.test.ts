import { describe, it, expect, afterEach } from "vitest";
import { resolveStateDir, resolveServerRoot } from "@/lib/serverRoot";

const savedState = process.env.MINDER_STATE_DIR;
const savedRoot = process.env.MINDER_SERVER_ROOT;

afterEach(() => {
  if (savedState === undefined) delete process.env.MINDER_STATE_DIR;
  else process.env.MINDER_STATE_DIR = savedState;
  if (savedRoot === undefined) delete process.env.MINDER_SERVER_ROOT;
  else process.env.MINDER_SERVER_ROOT = savedRoot;
});

describe("resolveStateDir (writable user-state precedence)", () => {
  it("returns MINDER_STATE_DIR when set (the tray points this at ~/.minder)", () => {
    process.env.MINDER_STATE_DIR = "C:\\Users\\someone\\.minder";
    expect(resolveStateDir()).toBe("C:\\Users\\someone\\.minder");
  });

  it("falls back to process.cwd() when unset (repo checkout keeps repo-root .minder.json)", () => {
    delete process.env.MINDER_STATE_DIR;
    expect(resolveStateDir()).toBe(process.cwd());
  });

  it("ignores an empty MINDER_STATE_DIR (treated as unset)", () => {
    process.env.MINDER_STATE_DIR = "";
    expect(resolveStateDir()).toBe(process.cwd());
  });

  it("is independent of MINDER_SERVER_ROOT (state dir ≠ install root)", () => {
    process.env.MINDER_SERVER_ROOT = "C:\\some\\bundle";
    delete process.env.MINDER_STATE_DIR;
    // State dir tracks cwd, not the (read-only) install root.
    expect(resolveStateDir()).toBe(process.cwd());
    expect(resolveServerRoot()).toBe("C:\\some\\bundle");
  });
});
