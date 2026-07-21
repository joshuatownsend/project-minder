import { describe, it, expect } from "vitest";
import {
  FORBIDDEN_ROOT_RELATIVE,
  isForbiddenName,
  isForbiddenRootRelative,
} from "../scripts/payload-hygiene-rules.mjs";

// These rules decide what can ship inside an installer, so the tests are
// written as "what must never leak" rather than as coverage of the branches.

describe("isForbiddenName", () => {
  it("catches the entries that actually shipped once (issue #284)", () => {
    expect(isForbiddenName(".git")).toBe(true);
    expect(isForbiddenName(".claude")).toBe(true);
    expect(isForbiddenName(".mcp.json")).toBe(true);
    expect(isForbiddenName("agentlytics-repo")).toBe(true);
  });

  // `.env*` is prefix semantics on purpose — the workflow and CHANGELOG both
  // promise `.env*`, not an enumerated list.
  it("treats .env as a prefix, not an exact name", () => {
    expect(isForbiddenName(".env")).toBe(true);
    expect(isForbiddenName(".env.local")).toBe(true);
    expect(isForbiddenName(".env.production")).toBe(true);
    expect(isForbiddenName(".envrc")).toBe(true);
  });

  it("is case-insensitive (Windows payloads)", () => {
    expect(isForbiddenName(".GIT")).toBe(true);
    expect(isForbiddenName(".Env.Local")).toBe(true);
  });

  it("leaves legitimate payload entries alone", () => {
    expect(isForbiddenName("node_modules")).toBe(false);
    expect(isForbiddenName("server.js")).toBe(false);
    expect(isForbiddenName("environment.js")).toBe(false);
  });
});

describe("isForbiddenRootRelative", () => {
  it("rejects the bundled Node runtime at the payload root", () => {
    expect(isForbiddenRootRelative("dist/node")).toBe(true);
  });

  it("accepts Windows separators, since the packager builds paths with them", () => {
    expect(isForbiddenRootRelative("dist\\node")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isForbiddenRootRelative("Dist/Node")).toBe(true);
  });

  // The whole reason this rule is root-anchored instead of a basename entry in
  // FORBIDDEN_EXACT: `node` is a common directory name, and banning it at any
  // depth would strip real dependencies out of the payload — a far worse
  // failure than the duplication it set out to prevent.
  it("does not match a `node` directory anywhere else in the payload", () => {
    expect(isForbiddenRootRelative("node")).toBe(false);
    expect(isForbiddenRootRelative("node_modules/.bin/node")).toBe(false);
    expect(isForbiddenRootRelative("node_modules/some-pkg/node")).toBe(false);
    expect(isForbiddenRootRelative("node_modules/next/dist/node")).toBe(false);
  });

  // A prefix/substring implementation would wrongly claim the real payload
  // subtree is forbidden and prune far more than intended.
  it("matches the directory itself, not paths beneath or beside it", () => {
    expect(isForbiddenRootRelative("dist/node/node.exe")).toBe(false);
    expect(isForbiddenRootRelative("dist/nodes")).toBe(false);
    expect(isForbiddenRootRelative("dist/mcp")).toBe(false);
  });

  it("ignores empty input (the payload root walks as \"\")", () => {
    expect(isForbiddenRootRelative("")).toBe(false);
  });
});

describe("hygiene rule sets", () => {
  // Guards the split itself: moving a root-anchored path into the basename set
  // would silently widen it to every depth.
  it("keeps root-anchored paths out of the basename set", () => {
    for (const entry of FORBIDDEN_ROOT_RELATIVE) {
      expect(entry).toContain("/");
      expect(isForbiddenName(entry)).toBe(false);
    }
  });
});
