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
import { PathSafetyError, assertContained, assertNotLink, canonicalPath } from "./pathSafety";

/**
 * Copy a single `.md` file (agent / skill standalone / command) from
 * `sourcePath` to `targetPath`, honoring the conflict policy.
 *
 * `sourcePath` MUST be the indexer's resolved real path — symlinks have
 * already been followed by the walker. Output is always a plain file
 * (we never recreate symlinks at the destination).
 *
 * `sourceRoot` (repository-controlled sources) and `targetRoot` bound where the file may be read from and
 * written to once symlinks and junctions are resolved (#633, #640).
 */
export async function applySingleFile(args: {
  sourcePath: string;
  targetPath: string;
  conflict: ConflictPolicy;
  dryRun?: boolean;
  sourceRoot?: string;
  targetRoot?: string;
}): Promise<ApplyResult> {
  const { sourcePath, conflict, dryRun } = args;
  let { targetPath } = args;

  try {
    if (args.sourceRoot) assertContained(sourcePath, args.sourceRoot);
    if (args.targetRoot) assertContained(targetPath, args.targetRoot);
    await assertNotLink(targetPath);
  } catch (e) {
    if (e instanceof PathSafetyError) return errorResult(e.code, e.message);
    throw e;
  }

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
  sourceRoot?: string;
  targetRoot?: string;
}): Promise<ApplyResult> {
  const { sourceDir, conflict, dryRun } = args;
  let { targetDir } = args;

  try {
    if (args.sourceRoot) {
      assertContained(sourceDir, args.sourceRoot);
      // A skill defined by a SKILL.md that links out of the project would otherwise be copied without it.
      const manifest = path.join(sourceDir, "SKILL.md");
      if (await fileExists(manifest)) assertContained(manifest, args.sourceRoot);
    }
    if (args.targetRoot) assertContained(targetDir, args.targetRoot);
    await assertNotLink(targetDir);
  } catch (e) {
    if (e instanceof PathSafetyError) return errorResult(e.code, e.message);
    throw e;
  }

  const exists = await fileExists(targetDir);

  // Validate the conflict policy + figure out the final target dir + whether
  // we'd need to remove the existing one — *without* mutating the filesystem.
  // Mutations come after the dryRun check.
  let willRemoveExisting = false;
  if (exists) {
    if (conflict === "skip") {
      return { ok: true, status: "skipped", changedFiles: [] };
    }
    if (conflict === "rename") {
      targetDir = await pickRenameDir(targetDir);
    } else if (conflict === "overwrite") {
      willRemoveExisting = true;
    } else {
      return errorResult(
        "INVALID_CONFLICT_POLICY",
        `Bundled skills do not support "${conflict}" — use skip, overwrite, or rename.`
      );
    }
  }

  const rootName = path.basename(sourceDir);

  if (dryRun) {
    const { files, totalBytes } = await listDirFiles(sourceDir, args.sourceRoot);
    const shown = files.slice(0, 12);
    const more = files.length - shown.length;
    const action = willRemoveExisting
      ? `[overwrite directory] ${rootName}/`
      : `[copy directory] ${rootName}/`;
    const preview =
      `${action}\n` +
      `  → ${targetDir}\n` +
      `  ${files.length} file${files.length === 1 ? "" : "s"}:\n` +
      shown.map((f) => `    - ${f}`).join("\n") +
      (more > 0 ? `\n    … (+${more} more)` : "");
    return {
      ok: true,
      status: "would-apply",
      changedFiles: [targetDir],
      diffPreview: preview,
      bundle: { rootName, files, totalBytes },
    };
  }

  // Real apply path: only here do we touch the filesystem.
  if (willRemoveExisting) {
    await fs.rm(targetDir, { recursive: true, force: true });
  }
  const written = await copyDirRecursive(sourceDir, targetDir, { containRoot: args.sourceRoot });
  const { files: writtenRelPaths } = await listDirFiles(sourceDir, args.sourceRoot);
  return {
    ok: true,
    status: "applied",
    changedFiles: written,
    bundle: { rootName, files: writtenRelPaths },
  };
}

/**
 * Walk `dir` and return every file path relative to it (sorted) plus total byte count. Mirrors
 * copyDirRecursive: a link leaving `containRoot` is skipped, a link to a directory is walked (unless it
 * loops back to a directory being walked), so the report matches what was actually copied.
 */
async function listDirFiles(dir: string, containRoot?: string): Promise<{ files: string[]; totalBytes: number }> {
  const out: string[] = [];
  let totalBytes = 0;
  const ancestors = new Set<string>();
  async function walk(curr: string, rel: string): Promise<void> {
    const here = canonicalPath(curr);
    if (ancestors.has(here)) return;
    ancestors.add(here);
    try {
      const entries = await fs.readdir(curr, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const full = path.join(curr, e.name);
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isSymbolicLink() && containRoot) {
          try {
            assertContained(full, containRoot);
          } catch {
            continue;
          }
        }
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) isDir = await fs.stat(full).then((st) => st.isDirectory(), () => false);
        if (isDir) {
          await walk(full, childRel);
        } else if (e.isFile() || e.isSymbolicLink()) {
          out.push(childRel);
          try {
            totalBytes += (await fs.stat(full)).size;
          } catch {
            // stat failure — skip size contribution
          }
        }
      }
    } finally {
      ancestors.delete(here);
    }
  }
  try {
    await walk(dir, "");
  } catch {
    // Source dir disappeared between the existence check and the walk — return
    // whatever we collected. The caller will see an empty list rather than throw.
  }
  return { files: out.sort(), totalBytes };
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
