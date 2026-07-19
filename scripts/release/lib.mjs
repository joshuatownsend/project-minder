// Pure helpers for scripts/release-local.mjs (plan task R1).
//
// Same split as scripts/service.mjs + scripts/service/lib.mjs: everything that
// can be decided without touching the filesystem, spawning a process, or exiting
// lives here so it can be unit-tested directly. The CLI wrapper does the I/O.
//
// Nothing in this file may call process.exit() or write to disk — the CLI turns
// the values and errors returned here into output and exit codes.

/**
 * Bundle target lists are interpolated into a shell command on Windows (pnpm is
 * a .cmd, which Node refuses to spawn without shell: true since 18.20/20.12), so
 * the value is validated against a strict allowlist rather than trusted. Tauri's
 * own target names are all lowercase-alphanumeric, so this rejects nothing real.
 */
export const BUNDLES_PATTERN = /^[a-z0-9]+(,[a-z0-9]+)*$/;

export function isValidBundleList(value) {
  return typeof value === "string" && BUNDLES_PATTERN.test(value);
}

/**
 * The bundle targets that make sense on a given platform.
 *
 * macOS Intel defaults to `app` alone, mirroring the CI matrix: DMG bundling
 * fails deterministically on Intel (hdiutil detach times out — create-dmg#72),
 * so a `dmg` default there would just waste a full build. Override with
 * --bundles if a local Intel Mac disagrees with GitHub's runners.
 */
export function defaultBundles(platform, arch) {
  if (platform === "win32") return "nsis";
  if (platform === "darwin") return arch === "arm64" ? "app,dmg" : "app";
  return "deb,appimage";
}

/**
 * Parse the CLI argv tail. Throws on bad input rather than exiting, so tests can
 * assert the message and the CLI can render it through its own `fail`.
 */
export function parseArgs(argv) {
  const opts = {
    bundles: null,
    skipBuild: false,
    skipNode: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--bundles": {
        const value = argv[++i];
        if (!value) {
          throw new Error("--bundles requires a value, e.g. --bundles nsis");
        }
        if (!isValidBundleList(value)) {
          throw new Error(
            `--bundles "${value}" is not a valid target list. ` +
              `Expected comma-separated lowercase names, e.g. "nsis" or "deb,appimage".`
          );
        }
        opts.bundles = value;
        break;
      }
      case "--skip-build":
        opts.skipBuild = true;
        break;
      case "--skip-node":
        opts.skipNode = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument "${arg}". Run with --help for usage.`);
    }
  }
  return opts;
}

/**
 * Decide whether a package.json version is releasable given the tag (if any) at
 * HEAD.
 *
 * CI can demand an exact package.json/tag match because it only ever builds a
 * tag. Locally the common case is the opposite — building a release candidate
 * from an untagged commit to see whether the installer even works — so an
 * unconditional match requirement would block the script's main use. The rule:
 * if HEAD IS tagged, tag and package.json must agree (a real mistagged-release
 * signal, exactly what CI guards); if HEAD is untagged, it's a dev build and we
 * only say so.
 *
 * @param version package.json version
 * @param tag     tag at HEAD, or null when HEAD is untagged
 * @returns {{ok: boolean, message: string}}
 */
export function checkVersionConsistency(version, tag) {
  if (!tag) {
    return {
      ok: true,
      message: `version ${version} (HEAD is untagged — building a dev/RC installer)`,
    };
  }
  const tagVersion = tag.replace(/^v/, "");
  if (tagVersion !== version) {
    return {
      ok: false,
      message:
        `package.json version (${version}) != tag ${tag} (expected ${tagVersion}). ` +
        `Fix the version bump or the tag before releasing — CI applies this same check.`,
    };
  }
  return { ok: true, message: `version ${version} (matches tag ${tag})` };
}

/**
 * Pick the tag to compare against from `git tag --points-at HEAD` output.
 * Only `v*` tags are release tags; anything else at HEAD is unrelated.
 */
export function selectReleaseTag(gitTagOutput) {
  if (!gitTagOutput) return null;
  const tags = gitTagOutput
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => /^v/.test(t));
  return tags[0] ?? null;
}

/**
 * Rewrite tauri.conf.json's version field, preserving the 2-space + trailing
 * newline formatting the CI stamp step produces so the two paths yield
 * byte-identical files.
 *
 * @returns {{text: string, previous: string}}
 */
export function stampVersionInConf(originalText, version, { updaterArtifacts } = {}) {
  const conf = JSON.parse(originalText);
  const previous = conf.version;
  conf.version = version;
  if (typeof updaterArtifacts === "boolean") {
    conf.bundle = { ...conf.bundle, createUpdaterArtifacts: updaterArtifacts };
  }
  return { text: JSON.stringify(conf, null, 2) + "\n", previous };
}

/**
 * Whether this build can produce signed updater artifacts.
 *
 * `bundle.createUpdaterArtifacts` is committed as `true` so CI signs every
 * release, but Tauri then REQUIRES `TAURI_SIGNING_PRIVATE_KEY` and fails the
 * build late without it. That would break `pnpm release:local` for every
 * contributor who doesn't hold the release key — while the docs promise it
 * produces a self-contained unsigned installer. So a local build without the
 * key turns updater artifacts off for that build rather than dying (PR #316
 * review); the installer it produces is simply not self-updatable, which is
 * exactly what "unsigned local build" already meant.
 */
/**
 * Typed as just the one key this reads, not the full `NodeJS.ProcessEnv` —
 * that interface has required members (NODE_ENV), which would force every
 * caller and test to construct a whole environment to pass one variable.
 * Same treatment as `resolveBoundPort` in src/lib/boundPort.ts.
 *
 * @param {{ TAURI_SIGNING_PRIVATE_KEY?: string }} [env]
 */
export function canSignUpdaterArtifacts(
  env = /** @type {{ TAURI_SIGNING_PRIVATE_KEY?: string }} */ (process.env)
) {
  return Boolean(env.TAURI_SIGNING_PRIVATE_KEY);
}

export function formatSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * The ordered list of shell-equivalent steps a run will perform, for --dry-run
 * and the up-front plan printout.
 */
export function buildPlan(opts, bundles) {
  return [
    opts.skipBuild ? null : "pnpm build",
    opts.skipBuild ? null : "pnpm package:standalone",
    "node scripts/verify-payload-hygiene.mjs",
    opts.skipNode ? null : "node scripts/fetch-node-runtime.mjs",
    `pnpm tauri build --bundles ${bundles}`,
  ].filter(Boolean);
}
