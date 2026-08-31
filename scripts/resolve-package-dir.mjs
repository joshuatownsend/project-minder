// Locate a package's directory from the directory that requires it.
//
// Extracted from package-standalone.mjs so it can be unit-tested against a
// fixture, because the bug it exists to fix was invisible on the platform this
// project is developed on and only appeared on the CI runners (#548).
//
// The obvious implementation asks Node for the package's manifest:
//
//     require.resolve(path.join(name, "package.json"), { paths: [fromDir] })
//
// Both halves of that line are wrong, and on Windows the two faults cancelled.
//
// 1. `./package.json` is not an exported subpath of every package. A package
//    whose `exports` map does not list it makes that call throw
//    ERR_PACKAGE_PATH_NOT_EXPORTED even though the file is right there. In
//    this tree that is `@huggingface/jinja`, `@huggingface/tokenizers`,
//    `onnxruntime-common`, `chokidar`, `client-only` and
//    `baseline-browser-mapping` — so the dependency-closure walk skipped them
//    with a warning and the payload shipped without them.
//
// 2. `path.join` builds a FILE PATH, not a module specifier. On Windows it
//    returns `@huggingface\jinja\package.json`, backslashes and all — which
//    Node does not recognise as a subpath request, so it falls back to legacy
//    resolution and BYPASSES the `exports` map entirely. The call therefore
//    succeeded on Windows and threw on macOS and Linux, for the same package
//    at the same version. Measured directly, from the transformers store dir:
//
//      "@huggingface/jinja/package.json"    -> ERR_PACKAGE_PATH_NOT_EXPORTED
//      "@huggingface\\jinja\\package.json"  -> ...\@huggingface\jinja\package.json
//
//    That is why every local packaging run was clean while three of four CI
//    bundle jobs failed: the developer machine was taking a different resolver
//    codepath from the runners.
//
// So this asks the filesystem instead, walking the same `node_modules` chain
// Node would. `existsSync` follows symlinks, which is what pnpm's virtual
// store is made of on POSIX. It is also immune to Node's negative-resolution
// cache (`Module._pathCache`), which `readPkgVersion` in the caller already
// avoids for the same reason: these lookups run before and after files are
// copied in, and a cached "not found" would outlive the copy.
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The directory holding `name`'s package.json, as resolved from `fromDir`.
 *
 * Throws with `code: "MODULE_NOT_FOUND"` when no candidate exists, matching
 * what callers already catch from `require.resolve`.
 */
export function resolvePackageDir(name, fromDir) {
  // Scoped names carry a real `/` that is part of the package identity; split
  // on it so the segments join with the platform separator rather than
  // arriving as one literal directory called "@huggingface/jinja".
  const segments = name.split("/");
  let dir = path.resolve(fromDir);
  for (;;) {
    // Skip a `node_modules` link in the chain — `.../node_modules/node_modules`
    // is never a real location, and Node's own algorithm omits it too.
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", ...segments);
      if (existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const err = new Error(
    `cannot find package "${name}" from ${fromDir} — no node_modules/${name}/package.json ` +
      `exists in any ancestor directory`
  );
  err.code = "MODULE_NOT_FOUND";
  throw err;
}
