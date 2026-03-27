import { promises as fs } from "fs";
import path from "path";
import { parseManualStepsMd } from "./scanner/manualStepsMd";
import { ManualStepsInfo } from "./types";

/**
 * Per-file mutex to serialize read-modify-write cycles.
 * Prevents concurrent toggles from clobbering each other.
 */
const fileLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const normalized = path.resolve(filePath);
  const prev = fileLocks.get(normalized) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn after previous completes (even if it failed)
  fileLocks.set(normalized, next);
  // Clean up the map entry once this operation finishes
  next.finally(() => {
    if (fileLocks.get(normalized) === next) {
      fileLocks.delete(normalized);
    }
  });
  return next;
}

/**
 * Atomic write: write to a temp file then rename.
 * On Windows, rename overwrites the target atomically at the FS level,
 * so concurrent readers never see partial content.
 */
async function atomicWriteFile(
  filePath: string,
  content: string
): Promise<void> {
  const tmpPath = filePath + ".tmp." + process.pid;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}

export async function toggleStepInFile(
  filePath: string,
  lineNumber: number
): Promise<ManualStepsInfo> {
  return withFileLock(filePath, async () => {
    const content = await fs.readFile(filePath, "utf-8");

    // Safety: never overwrite a file with empty/near-empty content.
    // A real MANUAL_STEPS.md always has at least a ## header + one step.
    if (content.trim().length < 10) {
      throw new Error(
        "MANUAL_STEPS.md appears empty or corrupted — refusing to write. " +
          "Restore from git or your editor's undo history."
      );
    }

    const lines = content.split("\n");
    const idx = lineNumber - 1; // 0-based

    if (idx >= 0 && idx < lines.length) {
      const line = lines[idx];
      if (line.match(/^\s*-\s*\[\s\]/)) {
        lines[idx] = line.replace("- [ ]", "- [x]");
      } else if (line.match(/^\s*-\s*\[x\]/i)) {
        lines[idx] = line.replace(/- \[x\]/i, "- [ ]");
      }
    }

    const newContent = lines.join("\n");
    await atomicWriteFile(filePath, newContent);
    return parseManualStepsMd(newContent);
  });
}
