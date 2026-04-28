import { promises as fs } from "fs";
import { spawn } from "child_process";
import path from "path";
import { MinderConfig } from "../types";
import { getDevRoots } from "../config";
import { ensureInsideDevRoots, PathSafetyError } from "./pathSafety";
import { fileExists } from "./atomicFs";

export interface BootstrapArgs {
  /** Display name (not used for the directory — `relPath` controls that). */
  name: string;
  /** Path relative to the first configured devRoot. */
  relPath: string;
  /** Run `git init` after mkdir. Defaults to true. */
  gitInit?: boolean;
}

export interface BootstrapSuccess {
  ok: true;
  createdPath: string;
  gitInitialized: boolean;
}

export interface BootstrapFailure {
  ok: false;
  error: { code: string; message: string };
}

/**
 * Resolves the desired new-project path against the first configured devRoot,
 * confirms it lives inside the dev roots and outside `.minder/`, refuses to
 * touch a path that already exists, then creates the directory and (optionally)
 * runs `git init`.
 *
 * Out of scope: package.json scaffolding, language setup, README, license.
 * Templates are config-only; the user adds language scaffolding themselves.
 */
export async function bootstrapNewProject(
  config: MinderConfig,
  args: BootstrapArgs
): Promise<BootstrapSuccess | BootstrapFailure> {
  const root = getDevRoots(config)[0];
  // Reject absolute paths outright — relPath is meant to be relative to root.
  if (path.isAbsolute(args.relPath)) {
    return {
      ok: false,
      error: {
        code: "ABSOLUTE_REL_PATH",
        message: `relPath must be relative to "${root}"; got absolute path "${args.relPath}".`,
      },
    };
  }
  if (args.relPath.length === 0) {
    return { ok: false, error: { code: "EMPTY_REL_PATH", message: "relPath must not be empty." } };
  }

  const requested = path.resolve(root, args.relPath);
  let safePath: string;
  try {
    safePath = ensureInsideDevRoots(requested, config);
  } catch (e) {
    if (e instanceof PathSafetyError) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    throw e;
  }

  if (await fileExists(safePath)) {
    return {
      ok: false,
      error: {
        code: "TARGET_EXISTS",
        message: `Target path "${safePath}" already exists. Use target.kind="existing" to apply into it instead.`,
      },
    };
  }

  await fs.mkdir(safePath, { recursive: true });

  let gitInitialized = false;
  if (args.gitInit !== false) {
    try {
      await runGitInit(safePath);
      gitInitialized = true;
    } catch (e) {
      // Non-fatal — directory still exists, user can `git init` themselves.
      // Return success with a flag rather than rolling back the mkdir, which
      // would surprise the user (their typed name would silently disappear).
      return {
        ok: true,
        createdPath: safePath,
        gitInitialized: false,
      };
    }
  }

  return { ok: true, createdPath: safePath, gitInitialized };
}

/** `git init` with no remote, no first commit. Resolves on success, rejects
 *  with the stderr text on non-zero exit. */
function runGitInit(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // execFile-style: argv array, no shell — no command-injection surface.
    const proc = spawn("git", ["init"], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git init exited ${code}: ${stderr.trim()}`));
    });
  });
}
