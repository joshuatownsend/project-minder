import { promises as fs } from "fs";
import path from "path";
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

/** Recursive copy of a directory tree. Used for bundled-skill apply. */
export async function copyDirRecursive(src: string, dest: string): Promise<string[]> {
  const written: string[] = [];
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const sFull = path.join(src, entry.name);
    const dFull = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      written.push(...(await copyDirRecursive(sFull, dFull)));
    } else if (entry.isSymbolicLink()) {
      // Resolve symlink and copy the real file (per the plan: never recreate symlinks).
      const real = await fs.realpath(sFull);
      const stat = await fs.stat(real);
      if (stat.isDirectory()) {
        written.push(...(await copyDirRecursive(real, dFull)));
      } else if (stat.isFile()) {
        await fs.copyFile(real, dFull);
        written.push(dFull);
      }
    } else if (entry.isFile()) {
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
