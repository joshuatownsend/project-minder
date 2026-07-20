import { describe, it, expect } from "vitest";
import {
  PLATFORM_KEYS,
  isValidPlatformKey,
  UPDATABLE_ARTIFACT,
  selectUpdaterSignature,
  splitExtension,
  updaterAssetName,
  assetUrl,
  buildManifest,
} from "../scripts/updater/lib.mjs";

describe("PLATFORM_KEYS", () => {
  // These strings are a protocol the installed client asks for by name, not
  // labels — a typo means "no update for this platform, forever".
  it("maps every CI runner to a Tauri updater target key", () => {
    expect(PLATFORM_KEYS["windows-latest"]).toBe("windows-x86_64");
    expect(PLATFORM_KEYS["macos-latest"]).toBe("darwin-aarch64");
    expect(PLATFORM_KEYS["macos-26-intel"]).toBe("darwin-x86_64");
    expect(PLATFORM_KEYS["ubuntu-22.04"]).toBe("linux-x86_64");
  });

  it("distinguishes the two macOS architectures", () => {
    expect(PLATFORM_KEYS["macos-latest"]).not.toBe(PLATFORM_KEYS["macos-26-intel"]);
  });

  it("validates keys", () => {
    expect(isValidPlatformKey("darwin-aarch64")).toBe(true);
    expect(isValidPlatformKey("darwin-arm64")).toBe(false);
    expect(isValidPlatformKey("windows-x64")).toBe(false);
    expect(isValidPlatformKey("")).toBe(false);
  });
});

describe("selectUpdaterSignature", () => {
  // These are the ACTUAL filenames from the v1.5.0 Linux job, which failed
  // because the code assumed exactly one .sig per job. Tauri signs the .deb
  // too, even though a .deb can never self-update.
  const linuxSigs = [
    "/b/appimage/Project Minder Tray_1.5.0_amd64.AppImage.sig",
    "/b/deb/Project Minder Tray_1.5.0_amd64.deb.sig",
  ];

  it("picks the AppImage on Linux and ignores the signed .deb", () => {
    expect(selectUpdaterSignature(linuxSigs, "linux-x86_64")).toBe(linuxSigs[0]);
  });

  // Publishing the .deb would put a URL in latest.json that every Linux client
  // downloads and then refuses ("Currently only an AppImage can be updated"),
  // and a bad entry can break checks on every other platform too.
  it("never selects a .deb", () => {
    expect(selectUpdaterSignature(linuxSigs, "linux-x86_64")).not.toContain(".deb");
  });

  it("picks the NSIS installer on Windows", () => {
    const sigs = [
      "/b/nsis/Project Minder Tray_1.5.0_x64-setup.exe.sig",
    ];
    expect(selectUpdaterSignature(sigs, "windows-x86_64")).toBe(sigs[0]);
  });

  // The arm64 job builds dmg,app — a signed .dmg would be the wrong artifact.
  it("picks the .app.tar.gz on macOS, not a .dmg", () => {
    const sigs = [
      "/b/dmg/Project Minder Tray_1.5.0_aarch64.dmg.sig",
      "/b/macos/Project Minder Tray.app.tar.gz.sig",
    ];
    expect(selectUpdaterSignature(sigs, "darwin-aarch64")).toBe(sigs[1]);
  });

  it("throws when the updatable bundle was not built", () => {
    expect(() =>
      selectUpdaterSignature(["/b/deb/x.deb.sig"], "linux-x86_64")
    ).toThrow(/no signed updatable artifact/);
  });

  // Signing silently produces nothing without the key; say so specifically.
  it("names the missing signing key when there are no signatures at all", () => {
    expect(() => selectUpdaterSignature([], "linux-x86_64")).toThrow(
      /TAURI_SIGNING_PRIVATE_KEY/
    );
  });

  it("refuses to guess between two matches", () => {
    expect(() =>
      selectUpdaterSignature(["/b/a.AppImage.sig", "/b/c/b.AppImage.sig"], "linux-x86_64")
    ).toThrow(/refusing to guess/);
  });

  it("throws for a platform with no rule", () => {
    expect(() => selectUpdaterSignature([], "solaris-sparc")).toThrow(/no updatable-artifact rule/);
  });

  it("has a rule for every platform key the CI matrix uses", () => {
    for (const key of Object.values(PLATFORM_KEYS)) {
      expect(UPDATABLE_ARTIFACT[key as keyof typeof UPDATABLE_ARTIFACT]).toBeInstanceOf(RegExp);
    }
  });
});

describe("splitExtension", () => {
  // Longest chain must win, or `.app.tar.gz` degrades to `.gz` and the stem
  // keeps a `.app.tar` that ends up in the uploaded filename.
  it("prefers the longest extension chain", () => {
    expect(splitExtension("Project Minder Tray.app.tar.gz")).toEqual([
      "Project Minder Tray",
      ".app.tar.gz",
    ]);
    expect(splitExtension("payload.tar.gz")).toEqual(["payload", ".tar.gz"]);
  });

  it("handles single extensions", () => {
    expect(splitExtension("Setup.exe")).toEqual(["Setup", ".exe"]);
    expect(splitExtension("app.AppImage")).toEqual(["app", ".AppImage"]);
  });

  // Versioned stems contain dots; splitting on the first one would truncate.
  it("does not split on dots inside the stem", () => {
    expect(splitExtension("Minder_1.4.0_x64-setup.exe")).toEqual([
      "Minder_1.4.0_x64-setup",
      ".exe",
    ]);
  });

  it("leaves an unknown extension attached to the stem", () => {
    expect(splitExtension("README")).toEqual(["README", ""]);
  });
});

describe("updaterAssetName", () => {
  // The whole reason this function exists: Tauri names the macOS updater
  // tarball with no arch, so both Mac jobs would upload different binaries
  // under one filename and the second would clobber the first.
  it("disambiguates the arch-less macOS tarball", () => {
    expect(updaterAssetName("Project Minder Tray.app.tar.gz", "darwin-aarch64")).toBe(
      "Project Minder Tray_darwin-aarch64.app.tar.gz"
    );
    expect(updaterAssetName("Project Minder Tray.app.tar.gz", "darwin-x86_64")).toBe(
      "Project Minder Tray_darwin-x86_64.app.tar.gz"
    );
  });

  it("gives the two macOS architectures distinct names", () => {
    const arm = updaterAssetName("Project Minder Tray.app.tar.gz", "darwin-aarch64");
    const intel = updaterAssetName("Project Minder Tray.app.tar.gz", "darwin-x86_64");
    expect(arm).not.toBe(intel);
  });

  // Renaming these would change the human-facing download name for no gain.
  it("leaves names that already carry an arch token untouched", () => {
    expect(updaterAssetName("Minder_1.4.0_x64-setup.exe", "windows-x86_64")).toBe(
      "Minder_1.4.0_x64-setup.exe"
    );
    expect(updaterAssetName("minder_1.4.0_amd64.AppImage", "linux-x86_64")).toBe(
      "minder_1.4.0_amd64.AppImage"
    );
    expect(updaterAssetName("Minder_1.4.0_aarch64.dmg", "darwin-aarch64")).toBe(
      "Minder_1.4.0_aarch64.dmg"
    );
  });
});

describe("assetUrl", () => {
  // GitHub serves asset names percent-encoded; an unencoded URL 404s at
  // download time, long after the check reported an update as available.
  it("percent-encodes spaces in the asset name", () => {
    expect(assetUrl("o/r", "v1.4.0", "Project Minder Tray_1.4.0_x64-setup.exe")).toBe(
      "https://github.com/o/r/releases/download/v1.4.0/Project%20Minder%20Tray_1.4.0_x64-setup.exe"
    );
  });

  it("pins the download to the tag, not to /latest", () => {
    expect(assetUrl("o/r", "v1.4.0", "a.exe")).toContain("/releases/download/v1.4.0/");
  });
});

describe("buildManifest", () => {
  const fragment = (platform: string, overrides = {}) => ({
    platform,
    version: "1.4.0",
    asset: `minder_${platform}.bin`,
    signature: `sig-for-${platform}`,
    ...overrides,
  });
  const opts = { repo: "o/r", tag: "v1.4.0", pubDate: "2026-07-19T00:00:00Z" };

  it("builds one entry per platform", () => {
    const manifest = buildManifest(
      [fragment("windows-x86_64"), fragment("linux-x86_64")],
      opts
    );
    expect(manifest.version).toBe("1.4.0");
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      "linux-x86_64",
      "windows-x86_64",
    ]);
    expect(manifest.platforms["windows-x86_64"].signature).toBe("sig-for-windows-x86_64");
    expect(manifest.platforms["windows-x86_64"].url).toContain("/releases/download/v1.4.0/");
  });

  it("carries pub_date and a notes link", () => {
    const manifest = buildManifest([fragment("linux-x86_64")], opts);
    expect(manifest.pub_date).toBe("2026-07-19T00:00:00Z");
    expect(manifest.notes).toContain("releases/tag/v1.4.0");
  });

  it("trims whitespace off signatures", () => {
    const manifest = buildManifest(
      [fragment("linux-x86_64", { signature: "  sig\n" })],
      opts
    );
    expect(manifest.platforms["linux-x86_64"].signature).toBe("sig");
  });

  // Every throw below is preferable to emitting the manifest anyway: Tauri
  // validates the WHOLE document before comparing versions, so one bad entry
  // breaks update checks for every user on every platform.
  it("refuses an empty fragment set rather than publishing an empty manifest", () => {
    expect(() => buildManifest([], opts)).toThrow(/no updater fragments/);
  });

  it("refuses fragments that disagree on version", () => {
    expect(() =>
      buildManifest(
        [fragment("linux-x86_64"), fragment("windows-x86_64", { version: "1.5.0" })],
        opts
      )
    ).toThrow(/disagree on version/);
  });

  it("refuses an empty signature", () => {
    expect(() =>
      buildManifest([fragment("linux-x86_64", { signature: "   " })], opts)
    ).toThrow(/empty signature/);
  });

  it("refuses a missing asset name", () => {
    expect(() =>
      buildManifest([fragment("linux-x86_64", { asset: "" })], opts)
    ).toThrow(/no asset name/);
  });

  it("refuses an unrecognized platform key", () => {
    expect(() => buildManifest([fragment("darwin-arm64")], opts)).toThrow(
      /unrecognized platform key/
    );
  });

  // Two jobs claiming one platform means the matrix drifted; silently keeping
  // the last would ship one architecture's binary to the other's users.
  it("refuses duplicate platforms", () => {
    expect(() =>
      buildManifest([fragment("linux-x86_64"), fragment("linux-x86_64")], opts)
    ).toThrow(/two fragments claim/);
  });
});
