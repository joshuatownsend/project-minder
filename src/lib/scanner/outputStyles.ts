import { promises as fs } from "fs";
import path from "path";
import { parseFrontmatter } from "../indexer/parseFrontmatter";
import type { OutputStyleEntry, OutputStylesInfo } from "../types";

/**
 * Reads `.claude/output-styles/<name>/PROMPT.md` (and any other .md file in
 * each style directory). Each subdirectory is treated as one output-style entry.
 */
export async function scanOutputStyles(
  projectPath: string,
): Promise<OutputStylesInfo | undefined> {
  const stylesDir = path.join(projectPath, ".claude", "output-styles");

  let subdirs: string[];
  try {
    const entries = await fs.readdir(stylesDir, { withFileTypes: true });
    subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return undefined;
  }

  if (subdirs.length === 0) return undefined;

  const styles: OutputStyleEntry[] = [];

  for (const name of subdirs) {
    const styleDir = path.join(stylesDir, name);
    let promptPath: string | undefined;
    let frontmatter: Record<string, unknown> = {};

    try {
      const files = await fs.readdir(styleDir);
      const mdFile =
        files.find((f) => f.toLowerCase() === "prompt.md") ??
        files.find((f) => f.toLowerCase().endsWith(".md"));
      if (mdFile) {
        promptPath = path.join(styleDir, mdFile);
        const content = await fs.readFile(promptPath, "utf-8");
        frontmatter = parseFrontmatter(content).fm;
      }
    } catch {
      // Style directory unreadable — skip.
    }

    if (promptPath) {
      styles.push({ name, promptPath, frontmatter });
    }
  }

  return styles.length > 0 ? { styles } : undefined;
}
