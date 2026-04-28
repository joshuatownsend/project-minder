import { promises as fs } from "fs";
import path from "path";
import {
  ApplyResult,
  ConflictPolicy,
} from "../types";
import {
  atomicWriteFile,
  copyDirRecursive,
  ensureDir,
  fileExists,
  previewFileWrite,
} from "./atomicFs";

/**
 * Copy a single `.md` file (agent / skill standalone / command) from
 * `sourcePath` to `targetPath`, honoring the conflict policy.
 *
 * `sourcePath` MUST be the indexer's resolved real path — symlinks have
 * already been followed by the walker. Output is always a plain file
 * (we never recreate symlinks at the destination).
 */
export async function applySingleFile(args: {
  sourcePath: string;
  targetPath: string;
  conflict: ConflictPolicy;
  dryRun?: boolean;
}): Promise<ApplyResult> {
  const { sourcePath, conflict, dryRun } = args;
  let { targetPath } = args;

  let content: string;
  try {
    content = await fs.readFile(sourcePath, "utf-8");
  } catch (e) {
    return errorResult(
      "SOURCE_READ_FAILED",
      `Could not read source file ${sourcePath}: ${(e as Error).message}`
    );
  }

  const exists = await fileExists(targetPath);
  if (exists) {
    if (conflict === "skip") {
      return { ok: true, status: "skipped", changedFiles: [] };
    }
    if (conflict === "rename") {
      targetPath = await pickRename(targetPath);
    } else if (conflict !== "overwrite" && conflict !== "merge") {
      return errorResult(
        "INVALID_CONFLICT_POLICY",
        `File units do not support conflict policy "${conflict}". Use skip, overwrite, or rename.`
      );
    }
    // "merge" on a file == overwrite (files have no internal merge semantics).
  }

  if (dryRun) {
    return {
      ok: true,
      status: "would-apply",
      changedFiles: [targetPath],
      diffPreview: await previewFileWrite(targetPath, content),
    };
  }

  await ensureDir(path.dirname(targetPath));
  await atomicWriteFile(targetPath, content);
  return { ok: true, status: "applied", changedFiles: [targetPath] };
}

/**
 * Recursively copy a directory (bundled skill). Conflict semantics:
 *   - skip:      target dir exists → no-op
 *   - overwrite: rm -rf target dir, then re-create
 *   - rename:    write to "<name>.copy" (or .copy.copy, …)
 *   - merge:     not supported for directories
 */
export async function applyDirectory(args: {
  sourceDir: string;
  targetDir: string;
  conflict: ConflictPolicy;
  dryRun?: boolean;
}): Promise<ApplyResult> {
  const { sourceDir, conflict, dryRun } = args;
  let { targetDir } = args;

  const exists = await fileExists(targetDir);
  if (exists) {
    if (conflict === "skip") {
      return { ok: true, status: "skipped", changedFiles: [] };
    }
    if (conflict === "rename") {
      targetDir = await pickRenameDir(targetDir);
    } else if (conflict === "overwrite") {
      await fs.rm(targetDir, { recursive: true, force: true });
    } else {
      return errorResult(
        "INVALID_CONFLICT_POLICY",
        `Bundled skills do not support "${conflict}" — use skip, overwrite, or rename.`
      );
    }
  }

  if (dryRun) {
    const files = await listDirFiles(sourceDir);
    const shown = files.slice(0, 12);
    const more = files.length - shown.length;
    const preview =
      `[copy directory] ${path.basename(sourceDir)}/\n` +
      `  → ${targetDir}\n` +
      `  ${files.length} file${files.length === 1 ? "" : "s"}:\n` +
      shown.map((f) => `    - ${f}`).join("\n") +
      (more > 0 ? `\n    … (+${more} more)` : "");
    return {
      ok: true,
      status: "would-apply",
      changedFiles: [targetDir],
      diffPreview: preview,
    };
  }

  const written = await copyDirRecursive(sourceDir, targetDir);
  return { ok: true, status: "applied", changedFiles: written };
}

/** Walk `dir` and return every file path relative to it, depth-first.
 *  Used by the bundled-skill dryRun preview so the user sees what's actually
 *  in the bundle before clicking apply. */
async function listDirFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(curr: string, rel: string): Promise<void> {
    const entries = await fs.readdir(curr, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(path.join(curr, e.name), childRel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        out.push(childRel);
      }
    }
  }
  try {
    await walk(dir, "");
  } catch {
    // Source dir disappeared between the existence check and the walk — return
    // whatever we collected. The caller will see an empty list rather than throw.
  }
  return out.sort();
}

async function pickRename(filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let i = 1; i < 100; i++) {
    const suffix = i === 1 ? ".copy" : `.copy${i}`;
    const candidate = path.join(dir, `${base}${suffix}${ext}`);
    if (!(await fileExists(candidate))) return candidate;
  }
  throw new Error(`Too many existing copies for ${filePath}`);
}

async function pickRenameDir(dirPath: string): Promise<string> {
  const parent = path.dirname(dirPath);
  const base = path.basename(dirPath);
  for (let i = 1; i < 100; i++) {
    const suffix = i === 1 ? ".copy" : `.copy${i}`;
    const candidate = path.join(parent, `${base}${suffix}`);
    if (!(await fileExists(candidate))) return candidate;
  }
  throw new Error(`Too many existing copies for ${dirPath}`);
}

function errorResult(code: string, message: string): ApplyResult {
  return {
    ok: false,
    status: "error",
    changedFiles: [],
    error: { code, message },
  };
}
