import { promises as fs } from "fs";
import path from "path";
import { assertContained, assertNotLink, canonicalPath } from "./pathSafety";
import { writeFileAtomic, withFileLock as sharedWithFileLock } from "../atomicWrite";

// Re-exported under the historic name `atomicWriteFile` so the template-mode
// callers don't need to be touched. New call sites should import
// `writeFileAtomic` from `@/lib/atomicWrite` directly.
export const atomicWriteFile = writeFileAtomic;
export const withFileLock = sharedWithFileLock;

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursive copy of a directory tree. Used for bundled-skill apply and live-source snapshots.
 *
 * Symlinks are resolved and the target copied (links are never recreated), but only when the target stays
 * inside `containRoot` (given for repository-controlled sources, #640), a directory is never re-entered while it is being copied
 * (a link back to an ancestor would otherwise recurse forever), and no destination entry may itself be a
 * link (#633).
 */
export async function copyDirRecursive(
  src: string,
  dest: string,
  opts: { containRoot?: string; ancestors?: Set<string> } = {},
): Promise<string[]> {
  // `ancestors` holds the canonical directories on the path from the top down to here. A link back to one
  // of them is a cycle; two different in-root paths to the same directory are not, and both are copied.
  const ancestors = opts.ancestors ?? new Set<string>();
  const here = canonicalPath(src);
  if (ancestors.has(here)) return [];
  if (opts.containRoot) assertContained(src, opts.containRoot);
  ancestors.add(here);
  try {
    return await copyEntries(src, dest, { ...opts, ancestors });
  } finally {
    ancestors.delete(here);
  }
}

async function copyEntries(
  src: string,
  dest: string,
  opts: { containRoot?: string; ancestors: Set<string> },
): Promise<string[]> {
  const written: string[] = [];
  await assertNotLink(dest);
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const sFull = path.join(src, entry.name);
    const dFull = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      written.push(...(await copyDirRecursive(sFull, dFull, opts)));
    } else if (entry.isSymbolicLink()) {
      if (opts.containRoot) {
        try {
          assertContained(sFull, opts.containRoot);
        } catch {
          continue; // points outside the source: skipped, not followed
        }
      }
      const real = await fs.realpath(sFull);
      const stat = await fs.stat(real);
      if (stat.isDirectory()) {
        written.push(...(await copyDirRecursive(real, dFull, opts)));
      } else if (stat.isFile()) {
        await assertNotLink(dFull);
        await fs.copyFile(real, dFull);
        written.push(dFull);
      }
    } else if (entry.isFile()) {
      await assertNotLink(dFull);
      await fs.copyFile(sFull, dFull);
      written.push(dFull);
    }
  }
  return written;
}

/** Minimal text diff for `.md` previews. Returns the literal new content when
 * there's no existing target — otherwise a unified-style block trimmed to the
 * first 40 lines so the API response stays bounded.
 */
export async function previewFileWrite(targetPath: string, newContent: string): Promise<string> {
  const exists = await fileExists(targetPath);
  if (!exists) {
    return `[new file] ${path.basename(targetPath)}\n${truncate(newContent, 40)}`;
  }
  const existing = await fs.readFile(targetPath, "utf-8");
  if (existing === newContent) return `[no change] ${path.basename(targetPath)}`;
  return (
    `[overwrite] ${path.basename(targetPath)}\n` +
    `--- existing\n${truncate(existing, 20)}\n` +
    `+++ new\n${truncate(newContent, 20)}`
  );
}

function truncate(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + `\n… (+${lines.length - maxLines} more lines)`;
}
