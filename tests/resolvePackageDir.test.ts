// #548 — the packaging script located packages by asking Node to resolve
// `<name>/package.json`, which throws for a package whose `exports` map does
// not list that subpath. On Windows the specifier was built with `path.join`,
// so it arrived backslash-separated, bypassed `exports`, and resolved anyway —
// which is why every local run was clean while three of four CI bundle jobs
// failed on the same commit.
//
// The fixture below reproduces exactly that shape: a package with an `exports`
// map that exposes only `.`. The first test fails against the old
// implementation on POSIX and passes on Windows; asserting on the resolved
// directory rather than on "it did not throw" is what makes it mean the same
// thing on both.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePackageDir } from "../scripts/resolve-package-dir.mjs";

let fixture: string;

/** Write a package.json into `dir`, creating it. */
function writePackage(dir: string, json: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(json, null, 2));
}

beforeAll(() => {
  fixture = mkdtempSync(path.join(tmpdir(), "resolve-pkg-dir-"));

  // A pnpm-shaped store subtree: the requiring package sits beside its
  // dependencies under one `node_modules`, not beneath its own.
  const subtree = path.join(fixture, "store", "requirer@1.0.0", "node_modules");

  writePackage(path.join(subtree, "requirer"), {
    name: "requirer",
    version: "1.0.0",
    dependencies: { "@scope/gated": "1.2.3", plain: "4.5.6" },
  });

  // The package at the heart of #548: `./package.json` is deliberately absent
  // from `exports`, exactly as @huggingface/jinja and chokidar have it.
  writePackage(path.join(subtree, "@scope", "gated"), {
    name: "@scope/gated",
    version: "1.2.3",
    exports: { ".": "./dist/index.js" },
  });

  writePackage(path.join(subtree, "plain"), { name: "plain", version: "4.5.6" });

  // A shadowing copy further up, to pin that the search stops at the nearest
  // one rather than falling through to an ancestor at another version.
  writePackage(path.join(fixture, "node_modules", "plain"), {
    name: "plain",
    version: "9.9.9",
  });
});

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe("resolvePackageDir", () => {
  it("finds a scoped package whose exports map does not expose ./package.json", () => {
    const from = path.join(fixture, "store", "requirer@1.0.0", "node_modules", "requirer");
    const resolved = resolvePackageDir("@scope/gated", from);

    expect(resolved).toBe(
      path.join(fixture, "store", "requirer@1.0.0", "node_modules", "@scope", "gated")
    );
  });

  // The negative control. Without it the test above only proves that SOME
  // lookup works, not that the fixture reproduces #548 at all — and a fixture
  // that quietly stopped being `exports`-gated would leave a green test
  // guarding nothing. Both assertions have to hold for the pair to mean
  // anything, and this one holds on every platform: it names the subpath with
  // a real `/`, which is what `path.join` failed to produce on Windows.
  it("reproduces the condition: Node itself refuses that package's ./package.json", () => {
    const from = path.join(fixture, "store", "requirer@1.0.0", "node_modules", "requirer");
    const req = createRequire(path.join(from, "package.json"));

    expect(() => req.resolve("@scope/gated/package.json")).toThrow(
      expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
    );
  });

  it("stops at the nearest copy rather than falling through to an ancestor", () => {
    const from = path.join(fixture, "store", "requirer@1.0.0", "node_modules", "requirer");

    expect(resolvePackageDir("plain", from)).toBe(
      path.join(fixture, "store", "requirer@1.0.0", "node_modules", "plain")
    );
  });

  it("walks up to an ancestor when the package is not a sibling", () => {
    const from = path.join(fixture, "store", "other@1.0.0", "node_modules", "other");

    expect(resolvePackageDir("plain", from)).toBe(path.join(fixture, "node_modules", "plain"));
  });

  it("throws MODULE_NOT_FOUND, the code callers already catch, when nothing matches", () => {
    const from = path.join(fixture, "store", "requirer@1.0.0", "node_modules", "requirer");

    expect(() => resolvePackageDir("absent-package", from)).toThrow(
      expect.objectContaining({ code: "MODULE_NOT_FOUND" })
    );
  });
});
