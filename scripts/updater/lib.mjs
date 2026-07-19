// Pure helpers for scripts/updater-manifest.mjs (plan task U5).
//
// Same split as service.mjs + service/lib.mjs: no filesystem, no process exit,
// no network — just the decisions, so they can be unit-tested directly.

/**
 * Tauri's updater target keys, by GitHub runner label. These strings are a
 * protocol, not a label: the installed app asks for exactly one of them and a
 * typo silently means "no update for this platform, forever".
 */
export const PLATFORM_KEYS = {
  "windows-latest": "windows-x86_64",
  "macos-latest": "darwin-aarch64",
  "macos-26-intel": "darwin-x86_64",
  "ubuntu-22.04": "linux-x86_64",
};

export function isValidPlatformKey(key) {
  return Object.values(PLATFORM_KEYS).includes(key);
}

/**
 * Extension chains we may see on an updater artifact, longest first so
 * `.app.tar.gz` wins over `.tar.gz` and neither is mistaken for `.gz`.
 */
const EXT_CHAINS = [".app.tar.gz", ".tar.gz", ".AppImage", ".exe", ".dmg", ".deb"];

/** Split a filename into [stem, extensionChain]; unknown extensions stay whole. */
export function splitExtension(name) {
  for (const ext of EXT_CHAINS) {
    if (name.toLowerCase().endsWith(ext.toLowerCase())) {
      return [name.slice(0, name.length - ext.length), name.slice(name.length - ext.length)];
    }
  }
  return [name, ""];
}

/** Arch tokens Tauri already bakes into most bundle filenames. */
const ARCH_TOKEN = /(x64|x86_64|amd64|aarch64|arm64)/i;

/**
 * The name an updater asset should be uploaded under.
 *
 * Most bundles already carry an arch token (`..._x64-setup.exe`,
 * `..._amd64.AppImage`) and are returned untouched, so the human-facing
 * installer keeps its familiar name. The exception that forces this function to
 * exist is macOS: Tauri names the updater tarball `<Product>.app.tar.gz` with no
 * arch at all, so the arm64 and Intel jobs would upload two different binaries
 * under one filename and the second would clobber the first — handing half your
 * Mac users the wrong architecture.
 */
export function updaterAssetName(originalName, platformKey) {
  if (ARCH_TOKEN.test(originalName)) return originalName;
  const [stem, ext] = splitExtension(originalName);
  return `${stem}_${platformKey}${ext}`;
}

/**
 * The GitHub Release download URL for an asset.
 *
 * Asset names contain spaces ("Project Minder Tray_1.4.0_x64-setup.exe"), and
 * GitHub serves them percent-encoded — an unencoded URL in the manifest 404s at
 * download time, long after the check reported an update as available.
 */
export function assetUrl(repo, tag, assetName) {
  return `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(assetName)}`;
}

/**
 * Build the static update manifest from one fragment per build job.
 *
 * Throws rather than emitting a partial manifest. That severity is deliberate:
 * Tauri validates the WHOLE manifest before it compares versions, so a single
 * malformed entry — even for a platform the checking client will never install —
 * breaks update checks for every user on every platform. A missing manifest is
 * recoverable; a poisoned one strands everyone until the next release.
 *
 * @param fragments emitted by `updater-manifest.mjs emit`
 * @param repo      "owner/repo"
 * @param tag       release tag, e.g. "v1.4.0"
 * @param pubDate   RFC 3339 timestamp
 */
export function buildManifest(fragments, { repo, tag, pubDate, notes = null }) {
  if (!Array.isArray(fragments) || fragments.length === 0) {
    throw new Error("no updater fragments found — every build job failed to emit one");
  }

  const versions = [...new Set(fragments.map((f) => f.version))];
  if (versions.length !== 1) {
    throw new Error(
      `updater fragments disagree on version: ${versions.join(", ")}. ` +
        `All build jobs must bundle the same version.`
    );
  }
  const version = versions[0];

  /** @type {Record<string, { signature: string, url: string }>} */
  const platforms = {};
  for (const fragment of fragments) {
    const { platform, asset, signature } = fragment;
    if (!isValidPlatformKey(platform)) {
      throw new Error(`fragment has an unrecognized platform key: ${platform}`);
    }
    if (platforms[platform]) {
      throw new Error(`two fragments claim platform ${platform}`);
    }
    // An empty signature is the specific failure that would ship a manifest the
    // client rejects wholesale, so it is worth its own message.
    if (!signature || !signature.trim()) {
      throw new Error(`fragment for ${platform} has an empty signature`);
    }
    if (!asset || !asset.trim()) {
      throw new Error(`fragment for ${platform} has no asset name`);
    }
    platforms[platform] = {
      signature: signature.trim(),
      url: assetUrl(repo, tag, asset),
    };
  }

  return {
    version,
    notes: notes ?? `See https://github.com/${repo}/releases/tag/${tag}`,
    pub_date: pubDate,
    platforms,
  };
}
