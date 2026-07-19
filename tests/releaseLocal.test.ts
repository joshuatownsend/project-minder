import { describe, it, expect } from "vitest";
import {
  BUNDLES_PATTERN,
  isValidBundleList,
  defaultBundles,
  parseArgs,
  checkVersionConsistency,
  selectReleaseTag,
  stampVersionInConf,
  canSignUpdaterArtifacts,
  formatSize,
  buildPlan,
} from "../scripts/release/lib.mjs";

describe("isValidBundleList", () => {
  it("accepts single and comma-separated lowercase targets", () => {
    expect(isValidBundleList("nsis")).toBe(true);
    expect(isValidBundleList("deb,appimage")).toBe(true);
    expect(isValidBundleList("app,dmg")).toBe(true);
  });

  // The value reaches a shell on Windows (pnpm is a .cmd, which needs
  // shell: true), so these rejections are a security boundary, not tidiness.
  it("rejects shell metacharacters", () => {
    expect(isValidBundleList("nsis; rm -rf /")).toBe(false);
    expect(isValidBundleList("nsis && whoami")).toBe(false);
    expect(isValidBundleList("nsis|cat")).toBe(false);
    expect(isValidBundleList("$(whoami)")).toBe(false);
    expect(isValidBundleList("nsis`id`")).toBe(false);
    expect(isValidBundleList("nsis nsis")).toBe(false);
  });

  it("rejects empty, non-string, and malformed lists", () => {
    expect(isValidBundleList("")).toBe(false);
    expect(isValidBundleList(",nsis")).toBe(false);
    expect(isValidBundleList("nsis,")).toBe(false);
    expect(isValidBundleList("nsis,,deb")).toBe(false);
    expect(isValidBundleList("NSIS")).toBe(false);
    expect(isValidBundleList(undefined)).toBe(false);
    expect(isValidBundleList(null)).toBe(false);
  });

  it("BUNDLES_PATTERN is not global (a lastIndex carry would flip results)", () => {
    expect(BUNDLES_PATTERN.global).toBe(false);
    expect(BUNDLES_PATTERN.test("nsis")).toBe(true);
    expect(BUNDLES_PATTERN.test("nsis")).toBe(true);
  });
});

describe("defaultBundles", () => {
  it("uses NSIS on Windows", () => {
    expect(defaultBundles("win32", "x64")).toBe("nsis");
  });

  it("builds app+dmg on Apple Silicon", () => {
    expect(defaultBundles("darwin", "arm64")).toBe("app,dmg");
  });

  // Mirrors the CI matrix: hdiutil detach times out deterministically on Intel
  // macOS, so defaulting to dmg there would waste an entire build.
  it("omits dmg on Intel macOS", () => {
    expect(defaultBundles("darwin", "x64")).toBe("app");
  });

  it("builds deb+appimage elsewhere", () => {
    expect(defaultBundles("linux", "x64")).toBe("deb,appimage");
  });
});

describe("parseArgs", () => {
  it("defaults every flag off", () => {
    expect(parseArgs([])).toEqual({
      bundles: null,
      skipBuild: false,
      skipNode: false,
      dryRun: false,
      help: false,
    });
  });

  it("parses each flag", () => {
    const opts = parseArgs(["--skip-build", "--skip-node", "--dry-run"]);
    expect(opts.skipBuild).toBe(true);
    expect(opts.skipNode).toBe(true);
    expect(opts.dryRun).toBe(true);
  });

  it("parses --bundles with its value", () => {
    expect(parseArgs(["--bundles", "deb,appimage"]).bundles).toBe("deb,appimage");
  });

  it("accepts both help spellings", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("throws when --bundles has no value", () => {
    expect(() => parseArgs(["--bundles"])).toThrow(/requires a value/);
  });

  it("throws on an invalid bundle list rather than passing it to a shell", () => {
    expect(() => parseArgs(["--bundles", "nsis; whoami"])).toThrow(
      /not a valid target list/
    );
  });

  it("throws on unknown arguments instead of silently ignoring them", () => {
    expect(() => parseArgs(["--sign"])).toThrow(/unknown argument/);
  });

  // A bare value would otherwise be swallowed as if it were a flag.
  it("throws on a positional argument", () => {
    expect(() => parseArgs(["nsis"])).toThrow(/unknown argument/);
  });
});

describe("selectReleaseTag", () => {
  it("returns null for no tags at HEAD", () => {
    expect(selectReleaseTag("")).toBeNull();
    expect(selectReleaseTag("\n")).toBeNull();
    expect(selectReleaseTag(null)).toBeNull();
  });

  it("picks the v-prefixed tag", () => {
    expect(selectReleaseTag("v1.4.0\n")).toBe("v1.4.0");
  });

  // Non-release tags at the same commit must not be mistaken for the release.
  it("ignores tags that are not release tags", () => {
    expect(selectReleaseTag("nightly\nbaseline\n")).toBeNull();
    expect(selectReleaseTag("nightly\nv2.0.0\n")).toBe("v2.0.0");
  });
});

describe("checkVersionConsistency", () => {
  it("allows an untagged HEAD as a dev build", () => {
    const result = checkVersionConsistency("1.4.0", null);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/untagged/);
  });

  it("passes when the tag matches package.json", () => {
    const result = checkVersionConsistency("1.4.0", "v1.4.0");
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/matches tag v1\.4\.0/);
  });

  // This is the mistagged-release guard CI applies; a mismatch here would ship
  // an installer whose reported version disagrees with its Release.
  it("fails when the tag disagrees with package.json", () => {
    const result = checkVersionConsistency("1.4.0", "v1.3.0");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/1\.4\.0/);
    expect(result.message).toMatch(/v1\.3\.0/);
  });
});

describe("stampVersionInConf", () => {
  const conf = JSON.stringify({ productName: "X", version: "0.1.0" }, null, 2) + "\n";

  it("replaces the placeholder version", () => {
    const { text, previous } = stampVersionInConf(conf, "1.4.0");
    expect(previous).toBe("0.1.0");
    expect(JSON.parse(text).version).toBe("1.4.0");
  });

  it("preserves other fields", () => {
    const { text } = stampVersionInConf(conf, "1.4.0");
    expect(JSON.parse(text).productName).toBe("X");
  });

  // CI writes JSON.stringify(c, null, 2) + "\n"; matching it byte-for-byte is
  // what keeps a local build and a CI build from producing different configs.
  it("emits 2-space JSON with a trailing newline, matching the CI stamp step", () => {
    const { text } = stampVersionInConf(conf, "1.4.0");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "version": "1.4.0"');
  });
});

describe("canSignUpdaterArtifacts", () => {
  it("is true only when the signing key is present and non-empty", () => {
    expect(canSignUpdaterArtifacts({ TAURI_SIGNING_PRIVATE_KEY: "untrusted..." })).toBe(true);
    expect(canSignUpdaterArtifacts({})).toBe(false);
    expect(canSignUpdaterArtifacts({ TAURI_SIGNING_PRIVATE_KEY: "" })).toBe(false);
  });
});

describe("stampVersionInConf — updater artifacts", () => {
  const conf =
    JSON.stringify(
      { version: "0.1.0", bundle: { active: true, createUpdaterArtifacts: true } },
      null,
      2
    ) + "\n";

  // PR #316 review: createUpdaterArtifacts is committed as true so CI signs
  // every release, but Tauri then REQUIRES TAURI_SIGNING_PRIVATE_KEY and fails
  // the build late without it. A contributor running `pnpm release:local`
  // without the release key would hit that — while the docs promise a
  // self-contained unsigned installer.
  it("turns updater artifacts off when the build cannot sign", () => {
    const { text } = stampVersionInConf(conf, "1.4.0", { updaterArtifacts: false });
    expect(JSON.parse(text).bundle.createUpdaterArtifacts).toBe(false);
  });

  it("leaves updater artifacts on when the build can sign", () => {
    const { text } = stampVersionInConf(conf, "1.4.0", { updaterArtifacts: true });
    expect(JSON.parse(text).bundle.createUpdaterArtifacts).toBe(true);
  });

  it("preserves the rest of the bundle config either way", () => {
    const { text } = stampVersionInConf(conf, "1.4.0", { updaterArtifacts: false });
    expect(JSON.parse(text).bundle.active).toBe(true);
    expect(JSON.parse(text).version).toBe("1.4.0");
  });

  // Omitting the option must not silently rewrite the committed value.
  it("leaves the flag untouched when no option is passed", () => {
    const { text } = stampVersionInConf(conf, "1.4.0");
    expect(JSON.parse(text).bundle.createUpdaterArtifacts).toBe(true);
  });
});

describe("formatSize", () => {
  it("uses MB at or above one megabyte", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(105 * 1024 * 1024)).toBe("105.0 MB");
  });

  it("uses KB below one megabyte", () => {
    expect(formatSize(2048)).toBe("2 KB");
  });
});

describe("buildPlan", () => {
  const base = { skipBuild: false, skipNode: false };

  it("lists the full five-step chain by default", () => {
    expect(buildPlan(base, "nsis")).toEqual([
      "pnpm build",
      "pnpm package:standalone",
      "node scripts/verify-payload-hygiene.mjs",
      "node scripts/fetch-node-runtime.mjs",
      "pnpm tauri build --bundles nsis",
    ]);
  });

  // The hygiene gate is the one step that must never be skippable: it is the
  // backstop that keeps .env/.git out of a shipped installer (#284).
  it("keeps the hygiene gate even when both skips are set", () => {
    const plan = buildPlan({ skipBuild: true, skipNode: true }, "nsis");
    expect(plan).toContain("node scripts/verify-payload-hygiene.mjs");
    expect(plan).not.toContain("pnpm build");
    expect(plan).not.toContain("node scripts/fetch-node-runtime.mjs");
  });

  it("threads the bundle list into the tauri step", () => {
    expect(buildPlan(base, "deb,appimage")).toContain(
      "pnpm tauri build --bundles deb,appimage"
    );
  });
});
