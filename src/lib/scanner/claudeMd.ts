import { promises as fs } from "fs";
import path from "path";

export async function scanClaudeMd(
  projectPath: string
): Promise<string | undefined> {
  try {
    const content = await fs.readFile(
      path.join(projectPath, "CLAUDE.md"),
      "utf-8"
    );
    // Return first ~500 chars as summary
    return content.slice(0, 500).trim();
  } catch {
    return undefined;
  }
}
