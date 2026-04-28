import { describe, it, expect } from "vitest";
import path from "path";
import {
  ensureInsideDevRoots,
  PathSafetyError,
} from "@/lib/template/pathSafety";
import type { MinderConfig } from "@/lib/types";

function configWithRoots(...roots: string[]): MinderConfig {
  return {
    statuses: {},
    hidden: [],
    portOverrides: {},
    devRoot: roots[0],
    devRoots: roots,
  };
}

describe("ensureInsideDevRoots", () => {
  const root = path.resolve("/dev");
  const otherRoot = path.resolve("/work");
  const config = configWithRoots(root, otherRoot);

  it("accepts a path inside the first root", () => {
    const result = ensureInsideDevRoots(path.join(root, "my-app"), config);
    expect(result).toBe(path.join(root, "my-app"));
  });

  it("accepts a path inside a non-first root", () => {
    const result = ensureInsideDevRoots(path.join(otherRoot, "side-project"), config);
    expect(result).toBe(path.join(otherRoot, "side-project"));
  });

  it("accepts a deeply nested path", () => {
    const result = ensureInsideDevRoots(
      path.join(root, "my-app", ".claude", "agents", "x.md"),
      config
    );
    expect(result).toBe(path.join(root, "my-app", ".claude", "agents", "x.md"));
  });

  it("rejects paths outside every root", () => {
    expect(() =>
      ensureInsideDevRoots(path.resolve("/somewhere/else/project"), config)
    ).toThrow(PathSafetyError);
  });

  it("rejects paths that try to escape via ..", () => {
    expect(() =>
      ensureInsideDevRoots(path.join(root, "..", "evil"), config)
    ).toThrow(PathSafetyError);
  });

  it("rejects exact `<root>/.minder` directory", () => {
    try {
      ensureInsideDevRoots(path.join(root, ".minder"), config);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as PathSafetyError).code).toBe("PATH_INSIDE_MINDER");
    }
  });

  it("rejects descendants of `<root>/.minder/`", () => {
    try {
      ensureInsideDevRoots(path.join(root, ".minder", "templates", "foo"), config);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as PathSafetyError).code).toBe("PATH_INSIDE_MINDER");
    }
  });

  it("does not confuse `<root>/.minderly` with `<root>/.minder`", () => {
    // Prefix-style false-positive guard: `.minderly` shares the prefix `.minder`.
    const ok = ensureInsideDevRoots(path.join(root, ".minderly"), config);
    expect(ok).toBe(path.join(root, ".minderly"));
  });

  it("does not confuse `<parent>/..minderly` with a `..` escape", () => {
    // Regression for the isInside startsWith("..") false-negative: a sibling
    // directory whose name happens to begin with `..` (rel = "..minderly")
    // is NOT an escape — the escape signal is `..` as its own segment.
    const customRoot = path.resolve("/customroot");
    const cfg = configWithRoots(customRoot);
    const child = path.join(customRoot, "..minderly");
    expect(ensureInsideDevRoots(child, cfg)).toBe(child);
  });

  it("error code is set on rejection", () => {
    try {
      ensureInsideDevRoots(path.resolve("/elsewhere"), config);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PathSafetyError);
      expect((e as PathSafetyError).code).toBe("PATH_OUTSIDE_DEV_ROOTS");
    }
  });
});
