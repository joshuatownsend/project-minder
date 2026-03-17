import { promises as fs } from "fs";
import { parseManualStepsMd } from "./scanner/manualStepsMd";
import { ManualStepsInfo } from "./types";

export async function toggleStepInFile(
  filePath: string,
  lineNumber: number
): Promise<ManualStepsInfo> {
  const content = await fs.readFile(filePath, "utf-8");
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

  await fs.writeFile(filePath, lines.join("\n"), "utf-8");
  return parseManualStepsMd(lines.join("\n"));
}
