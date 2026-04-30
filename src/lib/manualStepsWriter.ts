import { promises as fs } from "fs";
import { parseManualStepsMd } from "./scanner/manualStepsMd";
import { ManualStepsInfo } from "./types";
import { writeFileAtomic, withFileLock } from "./atomicWrite";

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
    await writeFileAtomic(filePath, newContent);
    return parseManualStepsMd(newContent);
  });
}
