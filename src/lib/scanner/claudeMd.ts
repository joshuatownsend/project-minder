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
    return content.trim();
  } catch {
    return undefined;
  }
}
