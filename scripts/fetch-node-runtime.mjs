// Downloads a PINNED Node runtime for the current OS/arch from nodejs.org and
// lays it out as the Tauri `node` resource for the C4 packaging workflow.
//
// The tray's packaged server (dist/minder-server/server.js) is spawned by a
// bundled Node — NOT the user's PATH node, which may be absent or the wrong
// major. Critically, `scripts/package-standalone.mjs` bundles better-sqlite3's
// prebuilt `.node` binary, which is ABI-tied to the Node major that RUNS the
// server (NODE_MODULE_VERSION). So the bundled runtime's major MUST match the
// Node the packaging job used for `pnpm build && package:standalone`. Both are
// pinned to the same NODE_VERSION below (22.x — better-sqlite3@12 ships a
// prebuilt for Node 22's ABI 127 on every target OS, and the repo's Windows CI
// already builds on 22.12.0 for exactly this reason).
//
// Integrity: the archive's SHA-256 is verified against the signed
// SHASUMS256.txt published alongside it on nodejs.org before anything is
// extracted. A mismatch aborts the build.
//
// Resulting layout (matches src-tauri/src/config.rs `bundled_node_candidates`):
//   Windows:      dist/node/node.exe
//   macOS/Linux:  dist/node/bin/node
//
// Usage:
//   node scripts/fetch-node-runtime.mjs             # download + place
//   node scripts/fetch-node-runtime.mjs --print-plan # print URL+dest, no I/O

import {
  mkdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  chmodSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The pinned Node major/minor/patch for BOTH the packaging step and the bundled
// runtime. Keep in sync with .github/workflows (release-installers.yml pins the
// same value for setup-node) and with package.json `engines`.
const NODE_VERSION = "22.12.0";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const destRoot = path.join(root, "dist", "node");

function fail(message) {
  console.error(`[fetch-node] ERROR: ${message}`);
  process.exit(1);
}
function step(message) {
  console.log(`[fetch-node] ${message}`);
}

// Map the current runner to the nodejs.org dist naming.
function resolvePlan() {
  const platform = os.platform(); // 'win32' | 'darwin' | 'linux'
  const arch = os.arch(); // 'x64' | 'arm64'

  let plat;
  let ext;
  if (platform === "win32") {
    plat = "win";
    ext = "zip";
  } else if (platform === "darwin") {
    plat = "darwin";
    ext = "tar.gz";
  } else if (platform === "linux") {
    plat = "linux";
    ext = "tar.gz"; // .gz (not .xz) so system `tar` needs no liblzma
  } else {
    fail(`unsupported platform: ${platform}`);
  }

  let nodeArch;
  if (arch === "x64") nodeArch = "x64";
  else if (arch === "arm64") nodeArch = "arm64";
  else fail(`unsupported arch: ${arch}`);

  const dirName = `node-v${NODE_VERSION}-${plat}-${nodeArch}`;
  const archiveName = `${dirName}.${ext}`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const archiveUrl = `${base}/${archiveName}`;
  const shasumsUrl = `${base}/SHASUMS256.txt`;

  // Where the node binary lives INSIDE the extracted archive, and where it must
  // land in dist/node (must mirror config.rs `bundled_node_candidates`).
  const binInArchive =
    platform === "win32"
      ? path.join(dirName, "node.exe")
      : path.join(dirName, "bin", "node");
  const binDest =
    platform === "win32"
      ? path.join(destRoot, "node.exe")
      : path.join(destRoot, "bin", "node");

  return {
    platform,
    dirName,
    archiveName,
    archiveUrl,
    shasumsUrl,
    binInArchive,
    binDest,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, attempts = 5) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      const detail = err?.cause?.code || err?.message || String(err);
      if (i < attempts) {
        const backoff = 1000 * i;
        console.warn(
          `[fetch-node] GET ${url} failed (${detail}) — retry ${i}/${
            attempts - 1
          } in ${backoff}ms`
        );
        await sleep(backoff);
      }
    }
  }
  fail(`GET ${url} failed after ${attempts} attempts: ${lastErr}`);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// SHASUMS256.txt lines are `<sha256>  <filename>` (two spaces). Find ours.
function expectedSha(shasumsText, archiveName) {
  for (const line of shasumsText.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/);
    if (m && m[2] === archiveName) return m[1];
  }
  return null;
}

const plan = resolvePlan();

if (process.argv.includes("--print-plan")) {
  console.log(JSON.stringify({ nodeVersion: NODE_VERSION, ...plan }, null, 2));
  process.exit(0);
}

const tmp = path.join(os.tmpdir(), `minder-node-${process.pid}`);
mkdirSync(tmp, { recursive: true });

try {
  step(`Downloading ${plan.archiveUrl}`);
  const archiveBuf = await download(plan.archiveUrl);

  step("Verifying SHA-256 against SHASUMS256.txt");
  const shasumsBuf = await download(plan.shasumsUrl);
  const want = expectedSha(shasumsBuf.toString("utf8"), plan.archiveName);
  if (!want) fail(`no SHASUMS256 entry for ${plan.archiveName}`);
  const got = sha256(archiveBuf);
  if (got !== want) {
    fail(
      `SHA-256 mismatch for ${plan.archiveName}\n  expected ${want}\n  got      ${got}`
    );
  }
  step(`Checksum OK (${want.slice(0, 16)}…)`);

  const archivePath = path.join(tmp, plan.archiveName);
  writeFileSync(archivePath, archiveBuf);

  // Extract. Windows Node archives are .zip → PowerShell's Expand-Archive
  // (always present, and unlike Git-bash's GNU `tar` it actually reads zip).
  // macOS/Linux Node archives are .tar.gz → system `tar`. Both are run with
  // cwd=tmp and a RELATIVE archive name: an absolute Windows path like
  // `C:\…\node.zip` makes GNU tar treat the `C:` as a remote `host:path`.
  step(`Extracting ${plan.archiveName}`);
  const res =
    plan.platform === "win32"
      ? spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Expand-Archive -Path '${plan.archiveName}' -DestinationPath . -Force`,
          ],
          { stdio: "inherit", cwd: tmp }
        )
      : spawnSync("tar", ["-xzf", plan.archiveName], {
          stdio: "inherit",
          cwd: tmp,
        });
  if (res.status !== 0) {
    fail(`extraction failed (exit ${res.status}, signal ${res.signal})`);
  }

  const extractedBin = path.join(tmp, plan.binInArchive);
  if (!existsSync(extractedBin)) {
    fail(`expected node binary not found after extraction: ${extractedBin}`);
  }

  // Place it fresh.
  rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(path.dirname(plan.binDest), { recursive: true });
  copyFileSync(extractedBin, plan.binDest);
  if (plan.platform !== "win32") chmodSync(plan.binDest, 0o755);

  const bytes = statSync(plan.binDest).size;
  step(
    `Placed Node ${NODE_VERSION} at ${path.relative(root, plan.binDest)} ` +
      `(${(bytes / (1024 * 1024)).toFixed(1)} MB)`
  );

  // Sanity: nothing else snuck into dist/node beyond the expected layout.
  step(`dist/node contents: ${readdirSync(destRoot).join(", ")}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
