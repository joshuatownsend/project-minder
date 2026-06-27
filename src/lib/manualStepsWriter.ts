import { promises as fs } from "fs";
import path from "path";
import { parseManualStepsMd } from "./scanner/manualStepsMd";
import { ManualStepsInfo } from "./types";
import { writeFileAtomic, withFileLock } from "./atomicWrite";
import { resolveCanonicalProjectPath } from "./canonicalProjectPath";
import { getDevRoots, readConfig } from "./config";

export async function toggleStepInFile(
  filePath: string,
  lineNumber: number
): Promise<ManualStepsInfo> {
  // This writer takes a full file path (unlike the todo/insights writers which
  // take a project dir). Canonicalize the *directory* so a worktree copy is
  // redirected to the main-tree MANUAL_STEPS.md, then re-attach the filename.
  const devRoots = getDevRoots(await readConfig());
  const { canonicalPath } = resolveCanonicalProjectPath(path.dirname(filePath), devRoots);
  const canonicalFile = path.join(canonicalPath, path.basename(filePath));
  return withFileLock(canonicalFile, async () => {
    const content = await fs.readFile(canonicalFile, "utf-8");

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
    await writeFileAtomic(canonicalFile, newContent);
    return parseManualStepsMd(newContent);
  });
}
