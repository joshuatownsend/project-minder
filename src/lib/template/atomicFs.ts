import { promises as fs } from "fs";
import path from "path";

/**
 * Per-file mutex keyed on the resolved absolute path. Mirrors the pattern in
 * `manualStepsWriter.ts` — a separate Map here is fine because Template Mode
 * targets `.claude/settings.json` and `.mcp.json`, which manual steps never
 * touch. Sharing a Map across modules would only matter if they wrote the same
 * files, which they don't.
 */
const fileLocks = new Map<string, Promise<unknown>>();

export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const normalized = path.resolve(filePath);
  const prev = fileLocks.get(normalized) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  fileLocks.set(normalized, next);
  next.finally(() => {
    if (fileLocks.get(normalized) === next) {
      fileLocks.delete(normalized);
    }
  });
  return next;
}

/** Write to a temp sibling, then rename. Rename is atomic on Windows and POSIX. */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmp = filePath + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2, 8);
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, filePath);
}

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
